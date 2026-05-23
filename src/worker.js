import {
  assertCanModerateTarget,
  assertCommandPermission,
  auditMessage,
  canUseModeratorCommands,
  deferredResponse,
  discordApi,
  editOriginalInteraction,
  formatMemberInfo,
  guildInfo,
  interactionUser,
  messageResponse,
  pong,
  requireGuild,
  requireModerator,
  sendChannelMessage,
  storeAndSendModLog,
  verifyDiscordRequest
} from "./discord.js";
import { fetchGameDetails, lookupPackage } from "./github.js";
import {
  PERMISSIONS,
  getOptionValue,
  getSubcommand,
  normalizeAppId,
  normalizeUserId,
  snowflakeToDate,
  storageCall,
  text,
  truncate,
  utcNow
} from "./utils.js";

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2
};

const SUCCESS = 0x05fff7;
const WARN = 0xf59e0b;
const DANGER = 0xef4444;
const MOD = 0x8b5cf6;

export class BotStorage {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const body = await request.json();
    const key = body.key;

    switch (body.op) {
      case "get": {
        const value = await this.state.storage.get(key);
        return Response.json({ value: value ?? body.fallback ?? null });
      }
      case "put": {
        await this.state.storage.put(key, body.value);
        return Response.json({ ok: true });
      }
      case "delete": {
        await this.state.storage.delete(key);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "Unknown storage op." }, { status: 400 });
    }
  }
}

function commandOptions(interaction) {
  const subcommand = getSubcommand(interaction.data);
  return subcommand?.options || interaction.data.options || [];
}

function commandOption(interaction, name, fallback = undefined) {
  return getOptionValue(commandOptions(interaction), name, fallback);
}

function subcommandName(interaction) {
  return getSubcommand(interaction.data)?.name || "";
}

function targetUser(interaction, optionName = "user") {
  const userId = commandOption(interaction, optionName);
  const user = interaction.data.resolved?.users?.[userId];
  const member = interaction.data.resolved?.members?.[userId];
  if (!userId || !user) throw new Error("Target user was not resolved.");
  return { userId, user, member };
}

function roleId(interaction, optionName = "role") {
  const value = commandOption(interaction, optionName);
  if (!value) throw new Error("Role was not resolved.");
  return String(value);
}

function channelId(interaction, optionName = "channel") {
  const value = commandOption(interaction, optionName);
  if (!value) throw new Error("Channel was not resolved.");
  return String(value);
}

function embed(title, fields = [], color = SUCCESS) {
  return {
    title,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "Charon Bot" }
  };
}

function gameEmbed(game, source = null) {
  const fields = [
    { name: "App ID", value: String(game.appId), inline: true },
    {
      name: "Publisher",
      value: game.publishers.length ? truncate(game.publishers.join(", "), 1000) : "Unknown",
      inline: true
    },
    { name: "Release Date", value: game.releaseDate || "Unknown", inline: true }
  ];

  if (source) {
    fields.push({ name: "Source", value: source, inline: true });
  }

  const result = {
    title: game.name || `Steam App ${game.appId}`,
    color: SUCCESS,
    fields,
    footer: { text: "Charon Manifest Tool" }
  };

  if (game.banner) {
    result.image = { url: game.banner };
  }

  return result;
}

async function sendResult(env, interaction, result) {
  if (typeof result === "string") {
    await editOriginalInteraction(env, interaction, result);
    return;
  }
  await editOriginalInteraction(env, interaction, result.content || "", result.file || null, {
    embeds: result.embeds || []
  });
}

async function getStored(env, key, fallback) {
  const data = await storageCall(env, "get", { key, fallback });
  return data.value ?? fallback;
}

async function putStored(env, key, value) {
  await storageCall(env, "put", { key, value });
}

function snowflakeMs(id) {
  const discordEpoch = 1420070400000n;
  return Number((BigInt(id) >> 22n) + discordEpoch);
}

function parseHexColor(value) {
  if (!value) return undefined;
  const raw = String(value).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) throw new Error("Color must be a hex value like #8b5cf6.");
  return Number.parseInt(raw, 16);
}

function userLabel(target) {
  return `${target.user?.username || target.userId} (${target.userId})`;
}

async function handleRequestCommand(env, interaction) {
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  const user = interactionUser(interaction);
  const timestamp = utcNow();
  const requestEntry = {
    appid: appId,
    userId: user.id,
    username: user.username,
    time: timestamp
  };

  const requests = await getStored(env, "requests", []);
  requests.unshift(requestEntry);
  await putStored(env, "requests", requests.slice(0, 100));

  await sendChannelMessage(env, env.REQUEST_CHANNEL, "", {
    embeds: [embed("New Game Request", [
      { name: "App ID", value: appId, inline: true },
      { name: "Requested By", value: `${user.username}\n${user.id}`, inline: true },
      { name: "Timestamp", value: timestamp, inline: false }
    ], SUCCESS)]
  });
}

async function handleGenCommand(env, interaction) {
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  await editOriginalInteraction(env, interaction, "Generating...");

  const [game, result] = await Promise.all([
    fetchGameDetails(appId),
    lookupPackage(env, appId)
  ]);

  if (!result) {
    await editOriginalInteraction(env, interaction, `No files found for AppID ${appId}`, null, {
      embeds: [gameEmbed(game)]
    });
    return;
  }

  await editOriginalInteraction(env, interaction, `Generated for AppID ${appId}`, {
    filename: result.fileName || `${appId}.zip`,
    bytes: result.bytes,
    contentType: "application/zip"
  }, {
    embeds: [gameEmbed(game, result.source)]
  });
}

async function handleAdminCommand(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const moderators = await getStored(env, "moderators", []);

  if (action === "add") {
    const userId = normalizeUserId(commandOption(interaction, "userid"));
    if (!moderators.includes(userId)) {
      moderators.push(userId);
      await putStored(env, "moderators", moderators);
    }
    return "Moderator added.";
  }

  if (action === "remove") {
    const userId = normalizeUserId(commandOption(interaction, "userid"));
    await putStored(env, "moderators", moderators.filter((id) => id !== userId));
    return "Moderator removed.";
  }

  if (action === "list") {
    return moderators.length
      ? `Moderators:\n${moderators.map((id) => `- <@${id}> (${id})`).join("\n")}`
      : "Moderators:\nNone";
  }

  if (action === "manifest") {
    const appId = normalizeAppId(commandOption(interaction, "appid"));
    const [game, result] = await Promise.all([
      fetchGameDetails(appId),
      lookupPackage(env, appId)
    ]);

    return {
      content: result ? `Manifest found for AppID ${appId}.` : `No manifest found for AppID ${appId}.`,
      embeds: [gameEmbed(game, result?.source || "Not found")]
    };
  }

  throw new Error("Unknown admin subcommand.");
}

async function handleRequestsCommand(env, interaction) {
  await requireModerator(env, interaction);
  const requests = (await getStored(env, "requests", [])).slice(0, 10);
  if (!requests.length) return "No requests yet.";
  return {
    embeds: [embed("Latest Game Requests", requests.map((request) => ({
      name: `AppID ${request.appid}`,
      value: `${request.username || request.userId}\n${request.time}`,
      inline: false
    })), SUCCESS)]
  };
}

async function handleRequestDeleteCommand(env, interaction) {
  await requireModerator(env, interaction);
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  const requests = await getStored(env, "requests", []);
  await putStored(env, "requests", requests.filter((request) => request.appid !== appId));
  return "Request removed.";
}

async function handleAnnouncement(env, interaction) {
  await requireModerator(env, interaction);
  const message = String(getOptionValue(interaction.data.options, "message", "")).trim();
  if (!message) throw new Error("Announcement message is required.");
  await sendChannelMessage(env, env.REQUEST_CHANNEL, "", {
    embeds: [embed("Announcement", [{ name: "Message", value: truncate(message, 1000), inline: false }], MOD)]
  });
  return "Announcement sent.";
}

async function logAction(env, interaction, action, target, reason) {
  const moderator = interactionUser(interaction);
  const entry = {
    action,
    moderator: { id: moderator.id, username: moderator.username },
    target,
    reason: reason || "Not provided",
    time: utcNow()
  };
  await storeAndSendModLog(env, entry);
}

async function banTarget(env, interaction, options = {}) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.BAN_MEMBERS);
  const target = targetUser(interaction);
  const reason = commandOption(interaction, "reason", "Not provided");
  const days = Number(commandOption(interaction, "days", options.days ?? 0));
  await assertCanModerateTarget(env, interaction, target);

  await discordApi(env, `/guilds/${interaction.guild_id}/bans/${target.userId}?reason=${encodeURIComponent(reason)}`, {
    method: "PUT",
    body: { delete_message_seconds: Math.max(0, Math.min(7, days)) * 86400 }
  });

  if (options.soft) {
    await discordApi(env, `/guilds/${interaction.guild_id}/bans/${target.userId}?reason=${encodeURIComponent("Softban complete")}`, { method: "DELETE" });
    await logAction(env, interaction, "SOFTBAN", userLabel(target), reason);
    return "User softbanned.";
  }

  if (options.tempMinutes) {
    const tempbans = await getStored(env, "tempbans", []);
    tempbans.push({
      guildId: interaction.guild_id,
      userId: target.userId,
      until: new Date(Date.now() + options.tempMinutes * 60000).toISOString(),
      reason,
      moderatorId: interactionUser(interaction).id
    });
    await putStored(env, "tempbans", tempbans);
    await logAction(env, interaction, "TEMPBAN", userLabel(target), `${reason} (${options.tempMinutes} min)`);
    return "User temporarily banned.";
  }

  await logAction(env, interaction, "BAN", userLabel(target), reason);
  return "User banned.";
}

async function handleTempBan(env, interaction) {
  return banTarget(env, interaction, { tempMinutes: Number(commandOption(interaction, "duration")) });
}

async function handleUnban(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.BAN_MEMBERS);
  const userId = normalizeUserId(getOptionValue(interaction.data.options, "userid"));
  const reason = getOptionValue(interaction.data.options, "reason", "Unbanned");
  await discordApi(env, `/guilds/${interaction.guild_id}/bans/${userId}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
  await logAction(env, interaction, "UNBAN", userId, reason);
  return "User unbanned.";
}

async function handleKick(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.KICK_MEMBERS);
  const target = targetUser(interaction);
  const reason = commandOption(interaction, "reason", "Not provided");
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
  await logAction(env, interaction, "KICK", userLabel(target), reason);
  return "User kicked.";
}

async function handleMute(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MODERATE_MEMBERS);
  const target = targetUser(interaction);
  const duration = Number(commandOption(interaction, "duration"));
  const reason = commandOption(interaction, "reason", "Not provided");
  await assertCanModerateTarget(env, interaction, target);

  const until = new Date(Date.now() + duration * 60000).toISOString();
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}?reason=${encodeURIComponent(reason)}`, {
    method: "PATCH",
    body: { communication_disabled_until: until }
  });

  const mutetimes = await getStored(env, "mutetimes", {});
  mutetimes[target.userId] = { until, reason, moderatorId: interactionUser(interaction).id };
  await putStored(env, "mutetimes", mutetimes);
  await logAction(env, interaction, "MUTE", userLabel(target), `${reason} (${duration} min)`);
  return "User muted.";
}

async function handleUnmute(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MODERATE_MEMBERS);
  const target = targetUser(interaction);
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`, {
    method: "PATCH",
    body: { communication_disabled_until: null }
  });
  const mutetimes = await getStored(env, "mutetimes", {});
  delete mutetimes[target.userId];
  await putStored(env, "mutetimes", mutetimes);
  await logAction(env, interaction, "UNMUTE", userLabel(target), "Unmuted");
  return "User unmuted.";
}

async function warningsData(env) {
  const data = await getStored(env, "warnings", {});
  return data && typeof data === "object" ? data : {};
}

async function notesData(env) {
  const data = await getStored(env, "notes", {});
  return data && typeof data === "object" ? data : {};
}

async function handleWarn(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const reason = String(commandOption(interaction, "reason", "")).trim();
  await assertCanModerateTarget(env, interaction, target);
  const warnings = await warningsData(env);
  warnings[target.userId] ||= [];
  warnings[target.userId].unshift({ reason, moderatorId: interactionUser(interaction).id, time: utcNow() });
  await putStored(env, "warnings", warnings);
  await logAction(env, interaction, "WARN", userLabel(target), reason);
  return "Warning added.";
}

async function handleWarnings(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const warnings = await warningsData(env);
  const list = warnings[target.userId] || [];
  if (!list.length) return `Warnings for ${target.user.username}: 0`;
  return truncate([
    `Warnings for ${target.user.username}: ${list.length}`,
    ...list.slice(0, 10).map((warning, index) => `${index + 1}. ${warning.reason} - ${warning.time}`)
  ].join("\n"));
}

async function handleClearWarns(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const warnings = await warningsData(env);
  delete warnings[target.userId];
  await putStored(env, "warnings", warnings);
  await logAction(env, interaction, "CLEAR WARNS", userLabel(target), "Warnings cleared");
  return "Warnings cleared.";
}

async function handleNote(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const note = String(commandOption(interaction, "note", "")).trim();
  const notes = await notesData(env);
  notes[target.userId] ||= [];
  notes[target.userId].unshift({ note, moderatorId: interactionUser(interaction).id, time: utcNow() });
  await putStored(env, "notes", notes);
  await logAction(env, interaction, "NOTE", userLabel(target), note);
  return "Note added.";
}

async function handleCases(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const warnings = (await warningsData(env))[target.userId] || [];
  const notes = (await notesData(env))[target.userId] || [];
  const fields = [
    { name: "Warnings", value: warnings.length ? warnings.slice(0, 5).map((item, i) => `${i + 1}. ${item.reason} - ${item.time}`).join("\n") : "None", inline: false },
    { name: "Notes", value: notes.length ? notes.slice(0, 5).map((item, i) => `${i + 1}. ${item.note} - ${item.time}`).join("\n") : "None", inline: false }
  ];
  return { embeds: [embed(`Cases for ${target.user.username}`, fields, MOD)] };
}

async function handleModLogs(env, interaction) {
  await requireModerator(env, interaction);
  const maybeTarget = commandOption(interaction, "user", "");
  const user = maybeTarget ? targetUser(interaction) : null;
  const logs = (await getStored(env, "modlogs", []))
    .filter((log) => !user || String(log.target).includes(user.userId))
    .slice(0, 10);
  if (!logs.length) return "No moderation logs yet.";
  return {
    embeds: [embed("Recent Moderation Logs", logs.map((log) => ({
      name: `${log.action} - ${log.time}`,
      value: truncate(`Moderator: ${log.moderator.username || log.moderator.id}\nTarget: ${log.target}\nReason: ${log.reason}`, 1000),
      inline: false
    })), MOD)]
  };
}

async function fetchRecentMessages(env, channelIdValue, amount) {
  return discordApi(env, `/channels/${channelIdValue}/messages?limit=${Math.max(1, Math.min(100, amount))}`);
}

async function deleteMessages(env, channelIdValue, messages) {
  const ids = [...new Set(messages.map((message) => message.id))].slice(0, 100);
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const bulk = ids.filter((id) => snowflakeMs(id) > cutoff);
  const old = ids.filter((id) => snowflakeMs(id) <= cutoff);

  if (bulk.length > 1) {
    await discordApi(env, `/channels/${channelIdValue}/messages/bulk-delete`, {
      method: "POST",
      body: { messages: bulk }
    });
  } else if (bulk.length === 1) {
    await discordApi(env, `/channels/${channelIdValue}/messages/${bulk[0]}`, { method: "DELETE" });
  }

  for (const id of old) {
    await discordApi(env, `/channels/${channelIdValue}/messages/${id}`, { method: "DELETE" });
  }

  return ids.length;
}

async function handlePurge(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_MESSAGES);
  const mode = subcommandName(interaction) || "recent";
  const amount = Number(commandOption(interaction, "amount", 50));
  const messages = await fetchRecentMessages(env, interaction.channel_id, amount);
  const target = mode === "user" ? targetUser(interaction) : null;
  const linkPattern = /(https?:\/\/|discord\.gg\/|discord\.com\/invite\/)/i;
  const filtered = messages.filter((message) => {
    if (mode === "user") return message.author?.id === target.userId;
    if (mode === "bots") return Boolean(message.author?.bot);
    if (mode === "embeds") return Boolean(message.embeds?.length);
    if (mode === "links") return linkPattern.test(message.content || "");
    if (mode === "attachments") return Boolean(message.attachments?.length);
    return true;
  });
  const deleted = await deleteMessages(env, interaction.channel_id, filtered);
  await logAction(env, interaction, "PURGE", interaction.channel_id, `${deleted} messages (${mode})`);
  return `Deleted ${deleted} message(s).`;
}

async function handleClean(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_MESSAGES);
  const amount = Number(getOptionValue(interaction.data.options, "amount", 25));
  const messages = await fetchRecentMessages(env, interaction.channel_id, amount);
  const deleted = await deleteMessages(env, interaction.channel_id, messages);
  await logAction(env, interaction, "CLEAN", interaction.channel_id, `${deleted} messages`);
  return `Cleaned ${deleted} message(s).`;
}

async function handleNuke(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_CHANNELS);
  const confirm = String(getOptionValue(interaction.data.options, "confirm", "")).trim();
  if (confirm !== "NUCLEAR") throw new Error("Type NUCLEAR in the confirm option to nuke this channel.");
  const channel = await discordApi(env, `/channels/${interaction.channel_id}`);
  const created = await discordApi(env, `/guilds/${interaction.guild_id}/channels`, {
    method: "POST",
    body: {
      name: channel.name,
      type: channel.type,
      topic: channel.topic || undefined,
      parent_id: channel.parent_id || undefined,
      position: channel.position,
      nsfw: channel.nsfw || false,
      rate_limit_per_user: channel.rate_limit_per_user || 0,
      permission_overwrites: channel.permission_overwrites || []
    }
  });
  await sendChannelMessage(env, created.id, "Channel nuked and recreated by Charon.");
  await discordApi(env, `/channels/${interaction.channel_id}`, { method: "DELETE" });
  await logAction(env, interaction, "NUKE", channel.name, `New channel ${created.id}`);
  return `Channel recreated: <#${created.id}>`;
}

async function handleSlowmode(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_CHANNELS);
  const seconds = Math.max(0, Math.min(21600, Number(getOptionValue(interaction.data.options, "seconds"))));
  await discordApi(env, `/channels/${interaction.channel_id}`, {
    method: "PATCH",
    body: { rate_limit_per_user: seconds }
  });
  await logAction(env, interaction, "SLOWMODE", interaction.channel_id, `${seconds}s`);
  return "Slowmode updated.";
}

async function setChannelLock(env, interaction, locked) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_CHANNELS);
  const channel = await discordApi(env, `/channels/${interaction.channel_id}`);
  const overwrite = (channel.permission_overwrites || []).find((item) => item.id === interaction.guild_id) || { allow: "0", deny: "0" };
  let deny = BigInt(overwrite.deny || "0");
  if (locked) deny |= PERMISSIONS.SEND_MESSAGES;
  else deny &= ~PERMISSIONS.SEND_MESSAGES;
  await discordApi(env, `/channels/${interaction.channel_id}/permissions/${interaction.guild_id}`, {
    method: "PUT",
    body: { type: 0, allow: overwrite.allow || "0", deny: deny.toString() }
  });
  await logAction(env, interaction, locked ? "LOCK" : "UNLOCK", interaction.channel_id, locked ? "Channel locked" : "Channel unlocked");
  return locked ? "Channel locked." : "Channel unlocked.";
}

async function handleSticky(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_MESSAGES);
  const action = subcommandName(interaction);
  const sticky = await getStored(env, "sticky", {});
  if (action === "set") {
    const message = String(commandOption(interaction, "message", "")).trim();
    sticky[interaction.channel_id] = { message, updatedAt: utcNow(), updatedBy: interactionUser(interaction).id };
    await putStored(env, "sticky", sticky);
    await sendChannelMessage(env, interaction.channel_id, message);
    return "Sticky message saved and sent.";
  }
  if (action === "clear") {
    delete sticky[interaction.channel_id];
    await putStored(env, "sticky", sticky);
    return "Sticky message cleared.";
  }
  return sticky[interaction.channel_id]
    ? `Sticky: ${sticky[interaction.channel_id].message}`
    : "No sticky message configured for this channel.";
}

async function handleAutomod(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_GUILD);
  const action = subcommandName(interaction);
  const config = await getStored(env, "automod", { enabled: false, features: {}, wordfilter: [], whitelist: [], blacklist: [] });
  if (action === "enable") config.enabled = true;
  if (action === "disable") config.enabled = false;
  await putStored(env, "automod", config);
  return {
    embeds: [embed("Automod Config", [
      { name: "Enabled", value: String(config.enabled), inline: true },
      { name: "Features", value: Object.keys(config.features || {}).length ? Object.entries(config.features).map(([k, v]) => `${k}: ${v}`).join("\n") : "None", inline: false }
    ], MOD)]
  };
}

async function handleAutomodFeature(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_GUILD);
  const feature = interaction.data.name;
  const mode = String(getOptionValue(interaction.data.options, "mode", "status"));
  const config = await getStored(env, "automod", { enabled: false, features: {}, wordfilter: [], whitelist: [], blacklist: [] });
  config.features ||= {};
  if (mode === "enable") config.features[feature] = true;
  if (mode === "disable") config.features[feature] = false;
  await putStored(env, "automod", config);
  return `${feature}: ${config.features[feature] ? "enabled" : "disabled"}`;
}

async function handleListConfig(env, interaction, key, optionName) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_GUILD);
  const action = subcommandName(interaction);
  const config = await getStored(env, "automod", { enabled: false, features: {}, wordfilter: [], whitelist: [], blacklist: [] });
  config[key] ||= [];
  const value = String(commandOption(interaction, optionName, "")).trim();
  if (action === "add" && value && !config[key].includes(value)) config[key].push(value);
  if (action === "remove") config[key] = config[key].filter((item) => item !== value);
  await putStored(env, "automod", config);
  return `${key}:\n${config[key].length ? config[key].map((item) => `- ${item}`).join("\n") : "None"}`;
}

async function handleRole(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const action = subcommandName(interaction);

  if (action === "add" || action === "remove") {
    const target = targetUser(interaction);
    const id = roleId(interaction);
    await assertCanModerateTarget(env, interaction, target);
    await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}/roles/${id}`, {
      method: action === "add" ? "PUT" : "DELETE"
    });
    await logAction(env, interaction, `ROLE ${action.toUpperCase()}`, userLabel(target), `<@&${id}>`);
    return action === "add" ? "Role added." : "Role removed.";
  }

  if (action === "create") {
    const name = String(commandOption(interaction, "name", "")).trim();
    const color = parseHexColor(commandOption(interaction, "color", ""));
    const body = { name };
    if (color !== undefined) body.color = color;
    const role = await discordApi(env, `/guilds/${interaction.guild_id}/roles`, { method: "POST", body });
    await logAction(env, interaction, "ROLE CREATE", role.id, name);
    return `Role created: <@&${role.id}>`;
  }

  if (action === "delete") {
    const id = roleId(interaction);
    await discordApi(env, `/guilds/${interaction.guild_id}/roles/${id}`, { method: "DELETE" });
    await logAction(env, interaction, "ROLE DELETE", id, "Deleted");
    return "Role deleted.";
  }

  if (action === "edit") {
    const id = roleId(interaction);
    const name = commandOption(interaction, "name", "");
    const color = parseHexColor(commandOption(interaction, "color", ""));
    const body = {};
    if (name) body.name = String(name).trim();
    if (color !== undefined) body.color = color;
    if (!Object.keys(body).length) throw new Error("Give a name or color to edit.");
    await discordApi(env, `/guilds/${interaction.guild_id}/roles/${id}`, { method: "PATCH", body });
    await logAction(env, interaction, "ROLE EDIT", id, JSON.stringify(body));
    return "Role edited.";
  }

  throw new Error("Unknown role subcommand.");
}

async function handleAutorole(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const action = subcommandName(interaction);
  const config = await getStored(env, "roleconfig", { autorole: null, reactionroles: [] });
  if (action === "set") config.autorole = roleId(interaction);
  if (action === "clear") config.autorole = null;
  await putStored(env, "roleconfig", config);
  return config.autorole ? `Autorole: <@&${config.autorole}>` : "Autorole: none";
}

async function handleReactionRole(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const action = subcommandName(interaction);
  const config = await getStored(env, "roleconfig", { autorole: null, reactionroles: [] });
  config.reactionroles ||= [];
  if (action === "set") {
    const messageId = String(commandOption(interaction, "messageid"));
    const emoji = String(commandOption(interaction, "emoji"));
    const id = roleId(interaction);
    config.reactionroles = config.reactionroles.filter((item) => item.messageId !== messageId || item.emoji !== emoji);
    config.reactionroles.push({ messageId, emoji, roleId: id });
  }
  if (action === "remove") {
    const messageId = String(commandOption(interaction, "messageid"));
    const emoji = String(commandOption(interaction, "emoji"));
    config.reactionroles = config.reactionroles.filter((item) => item.messageId !== messageId || item.emoji !== emoji);
  }
  await putStored(env, "roleconfig", config);
  return config.reactionroles.length
    ? `Reaction roles:\n${config.reactionroles.map((item) => `- ${item.messageId} ${item.emoji} -> <@&${item.roleId}>`).join("\n")}`
    : "Reaction roles: none";
}

async function handleSelfRole(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const id = roleId(interaction);
  const user = interactionUser(interaction);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${user.id}/roles/${id}`, {
    method: action === "add" ? "PUT" : "DELETE"
  });
  return action === "add" ? "Self role added." : "Self role removed.";
}

async function handleTempRole(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const target = targetUser(interaction);
  const id = roleId(interaction);
  const duration = Number(commandOption(interaction, "duration"));
  const reason = commandOption(interaction, "reason", "Temporary role");
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}/roles/${id}`, { method: "PUT" });
  const temproles = await getStored(env, "temproles", []);
  temproles.push({
    guildId: interaction.guild_id,
    userId: target.userId,
    roleId: id,
    until: new Date(Date.now() + duration * 60000).toISOString(),
    reason
  });
  await putStored(env, "temproles", temproles);
  await logAction(env, interaction, "TEMPROLE", userLabel(target), `<@&${id}> for ${duration} min`);
  return "Temporary role added.";
}

async function handleRoleAll(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const id = roleId(interaction);
  let after = "0";
  let added = 0;
  for (let page = 0; page < 10; page += 1) {
    const members = await discordApi(env, `/guilds/${interaction.guild_id}/members?limit=1000&after=${after}`, { timeout: 20000 });
    if (!members.length) break;
    for (const member of members) {
      await discordApi(env, `/guilds/${interaction.guild_id}/members/${member.user.id}/roles/${id}`, { method: "PUT", timeout: 10000 }).catch(() => null);
      added += 1;
      after = member.user.id;
    }
    if (members.length < 1000) break;
  }
  await logAction(env, interaction, "ROLEALL", `<@&${id}>`, `${added} fetched members`);
  return `Role applied to ${added} fetched member(s).`;
}

async function handleMsg(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const message = String(getOptionValue(interaction.data.options, "message", "")).trim();
  const dm = await discordApi(env, "/users/@me/channels", {
    method: "POST",
    body: { recipient_id: target.userId }
  });
  await sendChannelMessage(env, dm.id, message);
  return "DM sent.";
}

async function handleSend(env, interaction) {
  await requireModerator(env, interaction);
  const targetChannel = channelId(interaction);
  const message = String(commandOption(interaction, "message", "")).trim();
  await sendChannelMessage(env, targetChannel, message);
  return `Message sent to <#${targetChannel}>.`;
}

async function handleNick(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const target = targetUser(interaction);
  const nickname = String(getOptionValue(interaction.data.options, "nickname", "")).trim();
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`, {
    method: "PATCH",
    body: { nick: nickname }
  });
  await logAction(env, interaction, "NICK", userLabel(target), nickname);
  return "Nickname updated.";
}

async function handleUserInfo(env, interaction) {
  await requireModerator(env, interaction);
  const target = targetUser(interaction);
  const warnings = await warningsData(env);
  let member = target.member;
  if (!member) member = await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`);
  return formatMemberInfo(target.user, member, warnings[target.userId] || []);
}

async function handleServerInfo(env, interaction) {
  await requireModerator(env, interaction);
  const { guild, channels } = await guildInfo(env, interaction.guild_id);
  return [
    `Server name: ${guild.name}`,
    `Server ID: ${guild.id}`,
    `Members: ${guild.approximate_member_count ?? "Unknown"}`,
    `Channels: ${channels.length}`,
    `Created: ${snowflakeToDate(guild.id)}`
  ].join("\n");
}

async function runCommand(env, interaction) {
  switch (interaction.data.name) {
    case "admin": return handleAdminCommand(env, interaction);
    case "requests": return handleRequestsCommand(env, interaction);
    case "request-delete": return handleRequestDeleteCommand(env, interaction);
    case "announce": return handleAnnouncement(env, interaction);
    case "kick": return handleKick(env, interaction);
    case "ban": return banTarget(env, interaction);
    case "tempban": return handleTempBan(env, interaction);
    case "unban": return handleUnban(env, interaction);
    case "softban": return banTarget(env, interaction, { soft: true, days: 1 });
    case "mute":
    case "timeout": return handleMute(env, interaction);
    case "unmute":
    case "untimeout": return handleUnmute(env, interaction);
    case "warn": return handleWarn(env, interaction);
    case "warnings": return handleWarnings(env, interaction);
    case "clearwarns": return handleClearWarns(env, interaction);
    case "note": return handleNote(env, interaction);
    case "cases": return handleCases(env, interaction);
    case "modlogs": return handleModLogs(env, interaction);
    case "purge": return handlePurge(env, interaction);
    case "clean": return handleClean(env, interaction);
    case "nuke": return handleNuke(env, interaction);
    case "slowmode": return handleSlowmode(env, interaction);
    case "lock": return setChannelLock(env, interaction, true);
    case "unlock": return setChannelLock(env, interaction, false);
    case "sticky": return handleSticky(env, interaction);
    case "automod": return handleAutomod(env, interaction);
    case "antispam":
    case "antilink":
    case "antiinvite":
    case "antiscam":
    case "antiraid":
    case "antiemoji":
    case "antimention":
    case "antibot": return handleAutomodFeature(env, interaction);
    case "wordfilter": return handleListConfig(env, interaction, "wordfilter", "word");
    case "whitelist": return handleListConfig(env, interaction, "whitelist", "target");
    case "blacklist": return handleListConfig(env, interaction, "blacklist", "target");
    case "role": return handleRole(env, interaction);
    case "autorole": return handleAutorole(env, interaction);
    case "reactionrole": return handleReactionRole(env, interaction);
    case "selfrole": return handleSelfRole(env, interaction);
    case "temprole": return handleTempRole(env, interaction);
    case "roleall": return handleRoleAll(env, interaction);
    case "msg": return handleMsg(env, interaction);
    case "send": return handleSend(env, interaction);
    case "nick": return handleNick(env, interaction);
    case "userinfo": return handleUserInfo(env, interaction);
    case "serverinfo": return handleServerInfo(env, interaction);
    default: throw new Error("Unknown command.");
  }
}

async function completeDeferredCommand(env, interaction) {
  try {
    const result = await runCommand(env, interaction);
    await sendResult(env, interaction, result);
  } catch (error) {
    await editOriginalInteraction(env, interaction, error.message || "Command failed.");
  }
}

async function processScheduled(env) {
  const now = Date.now();
  const tempbans = await getStored(env, "tempbans", []);
  const remainingBans = [];
  for (const ban of tempbans) {
    if (new Date(ban.until).getTime() > now) {
      remainingBans.push(ban);
      continue;
    }
    await discordApi(env, `/guilds/${ban.guildId}/bans/${ban.userId}?reason=${encodeURIComponent("Temporary ban expired")}`, { method: "DELETE" }).catch(() => null);
  }
  await putStored(env, "tempbans", remainingBans);

  const temproles = await getStored(env, "temproles", []);
  const remainingRoles = [];
  for (const entry of temproles) {
    if (new Date(entry.until).getTime() > now) {
      remainingRoles.push(entry);
      continue;
    }
    await discordApi(env, `/guilds/${entry.guildId}/members/${entry.userId}/roles/${entry.roleId}`, { method: "DELETE" }).catch(() => null);
  }
  await putStored(env, "temproles", remainingRoles);
}

export async function handleInteraction(request, env, ctx) {
  const rawBody = await request.text();
  if (!(await verifyDiscordRequest(request, env, rawBody))) return text("Invalid request signature.", 401);

  const interaction = JSON.parse(rawBody);
  if (interaction.type === INTERACTION_TYPE.PING) return pong();
  if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) return messageResponse("Unsupported interaction.");

  if (interaction.data.name === "request") {
    ctx.waitUntil(handleRequestCommand(env, interaction).catch((error) => console.error("request failed", error)));
    return messageResponse("Request submitted.", true);
  }

  if (interaction.data.name === "gen") {
    ctx.waitUntil(handleGenCommand(env, interaction).catch((error) =>
      editOriginalInteraction(env, interaction, error.message || "Generation failed.").catch(console.error)
    ));
    return deferredResponse(false);
  }

  if (!(await canUseModeratorCommands(env, interaction))) {
    return messageResponse("You do not have permission.", true);
  }

  ctx.waitUntil(completeDeferredCommand(env, interaction));
  return deferredResponse(true);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return text("Charon Discord bot is running.");
    }
    if (request.method !== "POST") {
      return text("Method not allowed.", 405);
    }
    return handleInteraction(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processScheduled(env));
  }
};
