import {
  addReaction,
  autocompleteResponse,
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
import {
  createManifestEmbed,
  createNoResultsEmbed,
  createWebsiteEmbed,
  extractImageAccentColor,
  websiteButton
} from "./embeds.js";
import { fetchGameDetails, lookupPackage, searchSteamSuggestions } from "./github.js";
import {
  MANIFEST_JOB_COMMANDS,
  createMailEmbed,
  handleCancelCommand,
  handleClaimCommand,
  handleFixCommand,
  handleManifestHistoryCommand,
  handleManifestJobComponent,
  handleManifestJobModal,
  handleManifestRequestCommand,
  handleManifestStatusCommand,
  handleQueueCommand,
  handleStatsCommand,
  isManifestJobComponent,
  isManifestJobModal,
  mailComponents
} from "./manifestJobs.js";
import {
  TICKET_COMMANDS,
  createQuickTicket,
  handleSetTicketCommand,
  handleTicketCommand,
  handleTicketComponent,
  handleTicketModal,
  isTicketComponent,
  isTicketModal
} from "./tickets.js";
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
  APPLICATION_COMMAND: 2,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5
};

const SUCCESS = 0x05fff7;
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
      case "manifestJobStartUpload": {
        const jobs = await this.state.storage.get("manifestJobs") || [];
        const index = jobs.findIndex((job) => String(job.id) === String(body.jobId));
        if (index === -1) return Response.json({ ok: false, reason: "NOT_FOUND" });
        const job = jobs[index];
        if (job.status === "COMPLETED" || job.uploaded) return Response.json({ ok: false, reason: "COMPLETED", job });
        if (job.status === "UPLOADING") return Response.json({ ok: false, reason: "UPLOADING", job });
        jobs[index] = {
          ...job,
          status: "UPLOADING",
          uploadStartedBy: body.userId,
          uploadStartedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await this.state.storage.put("manifestJobs", jobs);
        return Response.json({ ok: true, job: jobs[index] });
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

function messageEmbed(title, description, color = SUCCESS) {
  return {
    title,
    description: truncate(description || "Done.", 4000),
    color,
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

function downloadButton(url) {
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: "Download ZIP",
      url
    }]
  }];
}

function helpEmbed() {
  return embed("Charon Help", [
    {
      name: "Manifest Tools",
      value: "`/gen appid` - Generate/download ZIP\n`/request appid` - Request a game\n`/website` - Open the Charon website\n`/admin manifest appid` - Check source availability",
      inline: false
    },
    {
      name: "Moderation",
      value: "`/warn`, `/kick`, `/ban`, `/mute`, `/timeout`, `/purge`, `/lock`, `/slowmode`, `/cases`, `/modlogs`",
      inline: false
    },
    {
      name: "Community",
      value: "`/setticket` - Create ticket panel\n`/ticket` - Manage tickets\n`/poll`, `/vote`, `/suggest`, `/feedback`, `/report`, `/appeal`, `/bug`\n`/botstatus`, `/ping`, `/status` - Check bot health",
      inline: false
    }
  ], MOD);
}

async function botStatusEmbed(env) {
  const tickets = await getStored(env, "tickets", []);
  const moderators = await getStored(env, "moderators", []);
  return embed("Charon Bot Status", [
    { name: "Runtime", value: "Cloudflare Workers", inline: true },
    { name: "Mode", value: "Serverless Interactions", inline: true },
    { name: "Storage", value: "Durable Object", inline: true },
    { name: "Tickets", value: `${Array.isArray(tickets) ? tickets.filter((ticket) => ticket.status !== "deleted").length : 0} tracked`, inline: true },
    { name: "Admins", value: `${Array.isArray(moderators) ? moderators.length : 0} stored`, inline: true },
    { name: "Health", value: "Online and ready.", inline: false }
  ], SUCCESS);
}

function pingEmbed(interaction) {
  const createdAt = snowflakeMs(interaction.id);
  const latency = Math.max(0, Date.now() - createdAt);
  return embed("Pong", [
    { name: "Latency", value: `${latency} ms`, inline: true },
    { name: "Runtime", value: "Cloudflare Workers", inline: true }
  ], SUCCESS);
}

async function sendResult(env, interaction, result) {
  if (typeof result === "string") {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [messageEmbed("Charon", result)]
    });
    return;
  }
  const embeds = [...(result.embeds || [])];
  if (result.content) embeds.unshift(messageEmbed("Charon", result.content));
  await editOriginalInteraction(env, interaction, "", result.file || null, {
    embeds,
    components: result.components || []
  });
}

async function getStored(env, key, fallback) {
  const data = await storageCall(env, "get", { key, fallback });
  return data.value ?? fallback;
}

async function putStored(env, key, value) {
  await storageCall(env, "put", { key, value });
}

async function storeAdminLog(env, action, actor, target, reason = "Updated") {
  const logs = await getStored(env, "adminlogs", []);
  const entry = {
    action,
    actor: { id: actor.id, username: actor.username },
    target,
    reason,
    time: utcNow()
  };
  logs.unshift(entry);
  await putStored(env, "adminlogs", logs.slice(0, 100));
  return entry;
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

function userMention(id) {
  return `<@${id}>`;
}

async function dmUser(env, userId, title, fields = [], color = MOD) {
  try {
    const dm = await discordApi(env, "/users/@me/channels", {
      method: "POST",
      body: { recipient_id: userId }
    });
    await sendChannelMessage(env, dm.id, "", {
      embeds: [embed(title, fields, color)]
    });
    return true;
  } catch {
    return false;
  }
}

async function notifyUserAction(env, interaction, target, action, reason = "Not provided", fields = []) {
  const userId = typeof target === "string" ? target : target.userId;
  await dmUser(env, userId, `Charon Notice: ${action}`, [
    { name: "Server", value: interaction.guild_id || "Unknown", inline: false },
    { name: "Action", value: action, inline: true },
    { name: "Reason", value: truncate(reason || "Not provided", 1000), inline: false },
    ...fields
  ], MOD);
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

async function handlePoll(env, interaction) {
  requireGuild(interaction);
  const question = String(getOptionValue(interaction.data.options, "question", "")).trim();
  const options = ["option1", "option2", "option3", "option4"]
    .map((name) => String(getOptionValue(interaction.data.options, name, "")).trim())
    .filter(Boolean);
  if (!question || options.length < 2) throw new Error("Poll needs a question and at least two options.");

  const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  const message = await sendChannelMessage(env, interaction.channel_id, "", {
    embeds: [embed("Community Poll", [
      { name: "Question", value: truncate(question, 1000), inline: false },
      { name: "Options", value: options.map((option, index) => `${emojis[index]} ${option}`).join("\n"), inline: false },
      { name: "Created By", value: `<@${interactionUser(interaction).id}>`, inline: false }
    ], MOD)]
  });

  for (let index = 0; index < options.length; index += 1) {
    await addReaction(env, interaction.channel_id, message.id, emojis[index]).catch(() => null);
  }

  return "Poll created.";
}

async function handleGenCommand(env, interaction) {
  const startedAt = Date.now();
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  await editOriginalInteraction(env, interaction, "", null, {
    embeds: [messageEmbed("Generating", `Preparing manifest package for AppID **${appId}**...`, MOD)]
  });

  const [game, result] = await Promise.all([
    fetchGameDetails(appId),
    lookupPackage(env, appId)
  ]);

  if (!result) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [createNoResultsEmbed(appId)]
    });
    return;
  }

  const accentColor = await extractImageAccentColor(game.banner, `${appId}:${result.source}`);
  const manifestEmbed = createManifestEmbed({
    game,
    source: result.source,
    elapsedMs: Date.now() - startedAt,
    accentColor
  });

  if (result.downloadUrl && !result.bytes) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [manifestEmbed],
      components: downloadButton(result.downloadUrl)
    });
    return;
  }

  await editOriginalInteraction(env, interaction, "", {
    filename: result.fileName || `${appId}.zip`,
    bytes: result.bytes,
    contentType: "application/zip"
  }, {
    embeds: [manifestEmbed]
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
    await storeAdminLog(env, "ADMIN ADD", interactionUser(interaction), userId);
    await notifyUserAction(env, interaction, userId, "Admin Access Granted", "You were added as a Charon bot admin.");
    return "Moderator added.";
  }

  if (action === "remove") {
    const userId = normalizeUserId(commandOption(interaction, "userid"));
    await putStored(env, "moderators", moderators.filter((id) => id !== userId));
    await storeAdminLog(env, "ADMIN REMOVE", interactionUser(interaction), userId);
    await notifyUserAction(env, interaction, userId, "Admin Access Removed", "You were removed from Charon bot admins.");
    return "Moderator removed.";
  }

  if (action === "list") {
    return moderators.length
      ? `Moderators:\n${moderators.map((id) => `- <@${id}> (${id})`).join("\n")}`
      : "Moderators:\nNone";
  }

  if (action === "transfer") {
    const userId = normalizeUserId(commandOption(interaction, "userid"));
    const nextModerators = [...new Set([...moderators, userId])];
    await putStored(env, "moderators", nextModerators);
    await putStored(env, "adminOwner", userId);
    await storeAdminLog(env, "ADMIN TRANSFER", interactionUser(interaction), userId, "Ownership transferred");
    await notifyUserAction(env, interaction, userId, "Admin Ownership Transferred", "You were made Charon bot owner/admin.");
    return "Admin ownership transferred.";
  }

  if (action === "permissions") {
    return {
      embeds: [embed("Admin Permissions", [
        { name: "Bot Admin Source", value: "`/admin add` stored users", inline: false },
        { name: "Ticket Staff", value: "Only stored bot admins can claim, add users, reopen, delete, and export ticket transcripts.", inline: false },
        { name: "Server Managers", value: "Manage Server can run setup/admin commands, but ticket staff access comes from `/admin add`.", inline: false }
      ], MOD)]
    };
  }

  if (action === "logs") {
    const logs = (await getStored(env, "adminlogs", [])).slice(0, 10);
    return {
      embeds: [embed("Admin Logs", logs.length ? logs.map((log) => ({
        name: `${log.action} - ${log.time}`,
        value: `Actor: ${log.actor?.username || log.actor?.id}\nTarget: ${log.target}\nReason: ${log.reason}`,
        inline: false
      })) : [{ name: "No logs", value: "No admin actions stored yet.", inline: false }], MOD)]
    };
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

function sendFormatOptions(interaction) {
  return {
    format: String(commandOption(interaction, "format", "normal")),
    ping: Boolean(commandOption(interaction, "ping", false)),
    image: String(commandOption(interaction, "image", "")).trim(),
    title: String(commandOption(interaction, "title", "")).trim()
  };
}

async function sendFormattedChannelMessage(env, channel, message, options = {}) {
  const allowedMentions = options.ping ? { parse: ["users", "roles", "everyone"] } : { parse: [] };
  if (options.format === "embed") {
    const messageEmbedPayload = {
      description: truncate(message, 4000),
      color: MOD,
      timestamp: new Date().toISOString(),
      footer: { text: "Charon Bot" }
    };
    if (options.title) messageEmbedPayload.title = truncate(options.title, 200);
    if (options.image) messageEmbedPayload.image = { url: options.image };
    await sendChannelMessage(env, channel, "", {
      embeds: [messageEmbedPayload],
      allowedMentions
    });
    return;
  }
  await sendChannelMessage(env, channel, message, {
    rawContent: true,
    allowedMentions
  });
}

async function handleAnnouncement(env, interaction) {
  await requireModerator(env, interaction);
  const message = String(getOptionValue(interaction.data.options, "message", "")).trim();
  if (!message) throw new Error("Announcement message is required.");
  await sendFormattedChannelMessage(env, env.REQUEST_CHANNEL, message, sendFormatOptions(interaction));
  return "Announcement sent.";
}

async function handlePublish(env, interaction) {
  await requireModerator(env, interaction);
  const targetChannel = channelId(interaction);
  const message = String(commandOption(interaction, "message", "")).trim();
  await sendFormattedChannelMessage(env, targetChannel, message, sendFormatOptions(interaction));
  return `Published to <#${targetChannel}>.`;
}

async function handleEmbedCommand(env, interaction) {
  await requireModerator(env, interaction);
  const targetChannel = channelId(interaction);
  const message = String(commandOption(interaction, "message", "")).trim();
  await sendFormattedChannelMessage(env, targetChannel, message, { ...sendFormatOptions(interaction), format: "embed" });
  return `Embed sent to <#${targetChannel}>.`;
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
  await notifyUserAction(env, interaction, target, options.tempMinutes ? "Temporary Ban" : options.soft ? "Softban" : "Ban", reason, options.tempMinutes
    ? [{ name: "Duration", value: `${options.tempMinutes} minute(s)`, inline: true }]
    : []);

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
  await notifyUserAction(env, interaction, userId, "Unban", reason);
  await logAction(env, interaction, "UNBAN", userId, reason);
  return "User unbanned.";
}

async function handleKick(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.KICK_MEMBERS);
  const target = targetUser(interaction);
  const reason = commandOption(interaction, "reason", "Not provided");
  await assertCanModerateTarget(env, interaction, target);
  await notifyUserAction(env, interaction, target, "Kick", reason);
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
  await notifyUserAction(env, interaction, target, "Timeout", reason, [
    { name: "Duration", value: `${duration} minute(s)`, inline: true }
  ]);

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
  await notifyUserAction(env, interaction, target, "Timeout Removed", "Your timeout was removed.");
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
  await notifyUserAction(env, interaction, target, "Warning", reason);
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
  await notifyUserAction(env, interaction, target, "Warnings Cleared", "Your Charon warnings were cleared.");
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
    await notifyUserAction(env, interaction, target, action === "add" ? "Role Added" : "Role Removed", `<@&${id}>`);
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
  await notifyUserAction(env, interaction, target, "Temporary Role Added", reason, [
    { name: "Role", value: `<@&${id}>`, inline: true },
    { name: "Duration", value: `${duration} minute(s)`, inline: true }
  ]);
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
  await sendFormattedChannelMessage(env, targetChannel, message, sendFormatOptions(interaction));
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
  await notifyUserAction(env, interaction, target, "Nickname Updated", nickname);
  await logAction(env, interaction, "NICK", userLabel(target), nickname);
  return "Nickname updated.";
}

async function handleUserInfo(env, interaction) {
  const target = targetUser(interaction);
  const canSeePrivate = await canUseModeratorCommands(env, interaction);
  const warnings = canSeePrivate ? await warningsData(env) : {};
  let member = target.member;
  if (!member) member = await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`);
  return formatMemberInfo(target.user, member, warnings[target.userId] || []);
}

async function handleServerInfo(env, interaction) {
  const { guild, channels } = await guildInfo(env, interaction.guild_id);
  return [
    `Server name: ${guild.name}`,
    `Server ID: ${guild.id}`,
    `Members: ${guild.approximate_member_count ?? "Unknown"}`,
    `Channels: ${channels.length}`,
    `Created: ${snowflakeToDate(guild.id)}`
  ].join("\n");
}

async function handleAvatar(interaction) {
  const userId = commandOption(interaction, "user", interactionUser(interaction).id);
  const user = interaction.data.resolved?.users?.[userId] || interactionUser(interaction);
  const hash = user.avatar;
  const ext = hash?.startsWith("a_") ? "gif" : "png";
  const url = hash
    ? `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${ext}?size=1024`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) % 5n)}.png`;
  return {
    embeds: [{
      title: `${user.username}'s Avatar`,
      color: MOD,
      image: { url },
      footer: { text: "Charon Bot" }
    }]
  };
}

async function handleBanner(env, interaction) {
  const userId = commandOption(interaction, "user", interactionUser(interaction).id);
  const user = await discordApi(env, `/users/${userId}`);
  if (!user.banner) return "No banner found for this user.";
  const ext = user.banner.startsWith("a_") ? "gif" : "png";
  const url = `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${ext}?size=1024`;
  return {
    embeds: [{
      title: `${user.username}'s Banner`,
      color: MOD,
      image: { url },
      footer: { text: "Charon Bot" }
    }]
  };
}

async function handleChannelInfo(env, interaction) {
  const id = commandOption(interaction, "channel", interaction.channel_id);
  const channel = await discordApi(env, `/channels/${id}`);
  return {
    embeds: [embed("Channel Info", [
      { name: "Name", value: channel.name || id, inline: true },
      { name: "ID", value: channel.id, inline: true },
      { name: "Type", value: String(channel.type), inline: true },
      { name: "Topic", value: channel.topic || "None", inline: false }
    ], MOD)]
  };
}

async function handleInviteInfo(env, interaction) {
  const raw = String(commandOption(interaction, "code", "")).trim();
  const code = raw.split("/").filter(Boolean).pop();
  const invite = await discordApi(env, `/invites/${encodeURIComponent(code)}?with_counts=true`);
  return {
    embeds: [embed("Invite Info", [
      { name: "Code", value: invite.code, inline: true },
      { name: "Guild", value: invite.guild?.name || "Unknown", inline: true },
      { name: "Channel", value: invite.channel?.name || "Unknown", inline: true },
      { name: "Approx Members", value: String(invite.approximate_member_count ?? "Unknown"), inline: true }
    ], MOD)]
  };
}

async function handlePin(env, interaction, pinned) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_MESSAGES);
  const messageId = String(commandOption(interaction, "messageid", "")).trim();
  await discordApi(env, `/channels/${interaction.channel_id}/pins/${messageId}`, { method: pinned ? "PUT" : "DELETE" });
  return pinned ? "Message pinned." : "Message unpinned.";
}

async function handleQuote(env, interaction) {
  const messageId = String(commandOption(interaction, "messageid", "")).trim();
  const message = await discordApi(env, `/channels/${interaction.channel_id}/messages/${messageId}`);
  return {
    embeds: [{
      title: "Quoted Message",
      description: truncate(message.content || "No text content.", 4000),
      color: MOD,
      fields: [
        { name: "Author", value: `${message.author?.username || "Unknown"}\n${message.author?.id || ""}`, inline: true },
        { name: "Sent", value: message.timestamp || "Unknown", inline: true }
      ],
      footer: { text: "Charon Bot" },
      timestamp: new Date().toISOString()
    }]
  };
}

async function handleArchive(env, interaction) {
  await requireModerator(env, interaction);
  const amount = Number(getOptionValue(interaction.data.options, "amount", 50));
  const messages = (await fetchRecentMessages(env, interaction.channel_id, amount)).reverse();
  const textContent = messages.map((message) =>
    `[${message.timestamp}] ${message.author?.username || "Unknown"} (${message.author?.id || ""}): ${message.content || ""}`
  ).join("\n");
  await sendChannelMessage(env, env.MOD_LOG_CHANNEL || env.REQUEST_CHANNEL, "", {
    embeds: [embed("Channel Archive", [
      { name: "Channel", value: `<#${interaction.channel_id}>`, inline: true },
      { name: "Messages", value: String(messages.length), inline: true },
      { name: "Preview", value: truncate(textContent || "No messages.", 1000), inline: false }
    ], MOD)]
  });
  return "Archive sent to logs.";
}

async function handleWelcome(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const config = await getStored(env, "welcome", {});
  if (action === "setup") {
    config.channelId = channelId(interaction);
    config.message = String(commandOption(interaction, "message", "")).trim();
    config.updatedAt = utcNow();
    config.updatedBy = interactionUser(interaction).id;
    await putStored(env, "welcome", config);
    return "Welcome config saved.";
  }
  if (action === "disable") {
    await putStored(env, "welcome", {});
    return "Welcome config disabled.";
  }
  return config.channelId
    ? `Welcome channel: <#${config.channelId}>\nMessage: ${config.message}`
    : "Welcome config is not set.";
}

async function handleMail(env, interaction) {
  const action = subcommandName(interaction);
  const inboxes = await getStored(env, "mail", {});
  const user = interactionUser(interaction);

  if (action === "send" || action === "channel") {
    const subject = String(commandOption(interaction, "subject", "Charon Mail")).trim();
    const message = String(commandOption(interaction, "message", "")).trim();
    const appId = String(commandOption(interaction, "appid", "") || "");
    const components = mailComponents({
      appId,
      website: Boolean(commandOption(interaction, "website", false)),
      generate: Boolean(commandOption(interaction, "generate", false)),
      fix: Boolean(commandOption(interaction, "fix", false)),
      close: Boolean(commandOption(interaction, "close", false))
    });
    const mailEmbed = createMailEmbed({
      subject,
      message,
      sender: userMention(user.id)
    });

    if (action === "channel") {
      const targetChannel = channelId(interaction);
      await sendChannelMessage(env, targetChannel, "", {
        embeds: [mailEmbed],
        components
      });
      return `Mail sent to <#${targetChannel}>.`;
    }

    const target = targetUser(interaction);
    const id = Date.now().toString(36);
    inboxes[target.userId] ||= [];
    inboxes[target.userId].unshift({ id, from: user.id, subject, message, time: utcNow() });
    await putStored(env, "mail", inboxes);
    const dm = await discordApi(env, "/users/@me/channels", {
      method: "POST",
      body: { recipient_id: target.userId }
    });
    await sendChannelMessage(env, dm.id, "", {
      embeds: [mailEmbed],
      components
    });
    return "Mail sent.";
  }

  if (action === "delete") {
    const id = String(commandOption(interaction, "id", "")).trim();
    inboxes[user.id] = (inboxes[user.id] || []).filter((item) => item.id !== id);
    await putStored(env, "mail", inboxes);
    return "Mail deleted.";
  }

  const inbox = inboxes[user.id] || [];
  return {
    embeds: [embed("Inbox", inbox.length ? inbox.slice(0, 10).map((item) => ({
      name: `${item.id} - ${item.time}`,
      value: `From: <@${item.from}>\nSubject: ${item.subject || "Charon Mail"}\n${truncate(item.message, 800)}`,
      inline: false
    })) : [{ name: "Empty", value: "No mail yet.", inline: false }], MOD)]
  };
}

async function handleSelfRoles(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const config = await getStored(env, "selfroles", []);
  if (action === "panel") {
    const id = roleId(interaction);
    const label = String(commandOption(interaction, "label", "Get Role")).trim();
    const message = await sendChannelMessage(env, interaction.channel_id, "", {
      embeds: [embed("Self Roles", [{ name: label, value: `Click below to toggle <@&${id}>.`, inline: false }], MOD)],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 1,
          label,
          custom_id: `selfrole_toggle:${id}`
        }]
      }]
    });
    config.unshift({ roleId: id, label, channelId: interaction.channel_id, messageId: message.id, createdAt: utcNow() });
    await putStored(env, "selfroles", config.slice(0, 50));
    return "Self role panel created.";
  }
  return config.length
    ? `Self roles:\n${config.map((item) => `- <@&${item.roleId}> (${item.label})`).join("\n")}`
    : "No self roles configured.";
}

async function handleVote(env, interaction) {
  const question = String(getOptionValue(interaction.data.options, "question", "")).trim();
  const message = await sendChannelMessage(env, interaction.channel_id, "", {
    embeds: [embed("Community Vote", [{ name: "Question", value: truncate(question, 1000), inline: false }], MOD)]
  });
  await addReaction(env, interaction.channel_id, message.id, "👍").catch(() => null);
  await addReaction(env, interaction.channel_id, message.id, "👎").catch(() => null);
  return "Vote created.";
}

async function handleGiveaway(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const giveaways = await getStored(env, "giveaways", {});
  if (action === "start") {
    const prize = String(commandOption(interaction, "prize", "")).trim();
    const message = await sendChannelMessage(env, interaction.channel_id, "", {
      embeds: [embed("Giveaway", [
        { name: "Prize", value: truncate(prize, 1000), inline: false },
        { name: "How to enter", value: "Click the button below.", inline: false }
      ], MOD)],
      components: [{
        type: 1,
        components: [{ type: 2, style: 1, label: "Enter Giveaway", custom_id: "giveaway_enter" }]
      }]
    });
    giveaways[message.id] = { prize, channelId: interaction.channel_id, entries: [], createdAt: utcNow() };
    await putStored(env, "giveaways", giveaways);
    return "Giveaway started.";
  }
  const messageId = String(commandOption(interaction, "messageid", "")).trim();
  const giveaway = giveaways[messageId];
  if (!giveaway?.entries?.length) return "No entries found for that giveaway.";
  const winner = giveaway.entries[Math.floor(Math.random() * giveaway.entries.length)];
  await sendChannelMessage(env, giveaway.channelId, `Winner: <@${winner}>`, { rawContent: true, allowedMentions: { users: [winner], parse: [] } });
  return `Winner selected: <@${winner}>`;
}

async function handleSubmission(env, interaction, type) {
  const message = String(getOptionValue(interaction.data.options, "message", "")).trim();
  const user = interactionUser(interaction);
  if (type === "report" || type === "appeal") {
    return createQuickTicket(env, interaction, type, message);
  }
  const titles = {
    feedback: "Feedback",
    suggest: "Suggestion",
    bug: "Bug Report",
    report: "User Report",
    appeal: "Appeal"
  };
  await sendChannelMessage(env, env.MOD_LOG_CHANNEL || env.REQUEST_CHANNEL, "", {
    embeds: [embed(titles[type] || "Submission", [
      { name: "From", value: `<@${user.id}>\n${user.id}`, inline: true },
      { name: "Message", value: truncate(message, 1000), inline: false }
    ], MOD)]
  });
  return "Submitted.";
}

async function handleBackup(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  const backups = await getStored(env, "backups", []);
  if (action === "create") {
    const snapshot = {
      id: Date.now().toString(36),
      time: utcNow(),
      by: interactionUser(interaction).id,
      moderators: await getStored(env, "moderators", []),
      welcome: await getStored(env, "welcome", {}),
      automod: await getStored(env, "automod", {}),
      roleconfig: await getStored(env, "roleconfig", {}),
      selfroles: await getStored(env, "selfroles", [])
    };
    backups.unshift(snapshot);
    await putStored(env, "backups", backups.slice(0, 20));
    return `Backup created: ${snapshot.id}`;
  }
  if (action === "restore") {
    const id = String(commandOption(interaction, "id", "")).trim();
    const backup = backups.find((item) => item.id === id);
    if (!backup) throw new Error("Backup not found.");
    await putStored(env, "moderators", backup.moderators || []);
    await putStored(env, "welcome", backup.welcome || {});
    await putStored(env, "automod", backup.automod || {});
    await putStored(env, "roleconfig", backup.roleconfig || {});
    await putStored(env, "selfroles", backup.selfroles || []);
    return "Backup restored.";
  }
  return backups.length
    ? `Backups:\n${backups.map((item) => `- ${item.id} - ${item.time}`).join("\n")}`
    : "No backups yet.";
}

async function handleSearch(env, interaction) {
  await requireModerator(env, interaction);
  const action = subcommandName(interaction);
  if (action === "ticket") {
    const id = String(commandOption(interaction, "id", "")).trim().toLowerCase();
    const tickets = await getStored(env, "tickets", []);
    const ticket = tickets.find((item) => String(item.id).toLowerCase() === id);
    return ticket
      ? `Ticket ${ticket.id}: <#${ticket.channelId}> ${ticket.status} ${ticket.typeLabel}`
      : "Ticket not found.";
  }
  const target = targetUser(interaction);
  const [warnings, notes, tickets] = await Promise.all([
    warningsData(env),
    notesData(env),
    getStored(env, "tickets", [])
  ]);
  return {
    embeds: [embed("User Search", [
      { name: "User", value: `<@${target.userId}>\n${target.userId}`, inline: true },
      { name: "Warnings", value: String((warnings[target.userId] || []).length), inline: true },
      { name: "Notes", value: String((notes[target.userId] || []).length), inline: true },
      { name: "Tickets", value: String(tickets.filter((ticket) => ticket.userId === target.userId).length), inline: true }
    ], MOD)]
  };
}

async function handleSettings(env) {
  const [moderators, welcome, automod, roleconfig, tickets] = await Promise.all([
    getStored(env, "moderators", []),
    getStored(env, "welcome", {}),
    getStored(env, "automod", {}),
    getStored(env, "roleconfig", {}),
    getStored(env, "tickets", [])
  ]);
  return {
    embeds: [embed("Settings", [
      { name: "Admins", value: String(Array.isArray(moderators) ? moderators.length : 0), inline: true },
      { name: "Welcome", value: welcome.channelId ? `<#${welcome.channelId}>` : "Disabled", inline: true },
      { name: "Automod", value: automod.enabled ? "Enabled" : "Disabled", inline: true },
      { name: "Autorole", value: roleconfig.autorole ? `<@&${roleconfig.autorole}>` : "None", inline: true },
      { name: "Tickets", value: String(Array.isArray(tickets) ? tickets.length : 0), inline: true }
    ], MOD)]
  };
}

async function handleReset(env, interaction) {
  await requireModerator(env, interaction);
  const area = String(getOptionValue(interaction.data.options, "area", "")).trim().toLowerCase();
  const allowed = new Set(["welcome", "automod", "roleconfig", "sticky"]);
  if (!allowed.has(area)) throw new Error("Area must be one of: welcome, automod, roleconfig, sticky.");
  await putStored(env, area, area === "sticky" ? {} : {});
  return `${area} reset.`;
}

async function runCommand(env, interaction) {
  switch (interaction.data.name) {
    case "help": return { embeds: [helpEmbed()] };
    case "botstatus": return { embeds: [await botStatusEmbed(env)] };
    case "ping": return { embeds: [pingEmbed(interaction)] };
    case "status": return handleManifestStatusCommand(env, interaction);
    case "website": return { embeds: [createWebsiteEmbed()], components: websiteButton() };
    case "poll": return handlePoll(env, interaction);
    case "admin": return handleAdminCommand(env, interaction);
    case "fix": return handleFixCommand(env, interaction);
    case "claim": return handleClaimCommand(env, interaction, false);
    case "unclaim": return handleClaimCommand(env, interaction, true);
    case "queue": return handleQueueCommand(env, interaction);
    case "cancel": return handleCancelCommand(env, interaction);
    case "stats": return handleStatsCommand(env, interaction);
    case "setticket": return handleSetTicketCommand(env, interaction);
    case "ticket": return handleTicketCommand(env, interaction);
    case "requests": return handleRequestsCommand(env, interaction);
    case "request-delete": return handleRequestDeleteCommand(env, interaction);
    case "announce": return handleAnnouncement(env, interaction);
    case "publish": return handlePublish(env, interaction);
    case "embed": return handleEmbedCommand(env, interaction);
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
    case "selfroles": return handleSelfRoles(env, interaction);
    case "temprole": return handleTempRole(env, interaction);
    case "roleall": return handleRoleAll(env, interaction);
    case "msg": return handleMsg(env, interaction);
    case "send": return handleSend(env, interaction);
    case "nick": return handleNick(env, interaction);
    case "userinfo": return handleUserInfo(env, interaction);
    case "serverinfo": return handleServerInfo(env, interaction);
    case "avatar": return handleAvatar(interaction);
    case "banner": return handleBanner(env, interaction);
    case "channelinfo": return handleChannelInfo(env, interaction);
    case "inviteinfo": return handleInviteInfo(env, interaction);
    case "pin": return handlePin(env, interaction, true);
    case "unpin": return handlePin(env, interaction, false);
    case "quote": return handleQuote(env, interaction);
    case "archive": return handleArchive(env, interaction);
    case "welcome": return handleWelcome(env, interaction);
    case "mail": return handleMail(env, interaction);
    case "vote": return handleVote(env, interaction);
    case "giveaway": return handleGiveaway(env, interaction);
    case "feedback": return handleSubmission(env, interaction, "feedback");
    case "suggest": return handleSubmission(env, interaction, "suggest");
    case "bug": return handleSubmission(env, interaction, "bug");
    case "report": return handleSubmission(env, interaction, "report");
    case "appeal": return handleSubmission(env, interaction, "appeal");
    case "backup": return handleBackup(env, interaction);
    case "logs": return handleModLogs(env, interaction);
    case "history": return handleManifestHistoryCommand(env, interaction);
    case "search": return handleSearch(env, interaction);
    case "settings": return handleSettings(env);
    case "config": return handleSettings(env);
    case "reset": return handleReset(env, interaction);
    default: throw new Error("Unknown command.");
  }
}

async function completeDeferredCommand(env, interaction) {
  try {
    const result = await runCommand(env, interaction);
    await sendResult(env, interaction, result);
  } catch (error) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [messageEmbed("Command Failed", error.message || "Command failed.", DANGER)]
    });
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

const PUBLIC_COMMANDS = new Set([
  "request",
  "gen",
  "help",
  "botstatus",
  "ping",
  "status",
  "history",
  "stats",
  "website",
  "poll",
  "avatar",
  "banner",
  "channelinfo",
  "inviteinfo",
  "serverinfo",
  "userinfo",
  "quote",
  "mail",
  "vote",
  "feedback",
  "suggest",
  "bug",
  "report",
  "appeal"
]);

function focusedAutocompleteValue(interaction) {
  const option = (interaction.data.options || []).find((item) => item.focused) ||
    (interaction.data.options || []).flatMap((item) => item.options || []).find((item) => item.focused);
  return option?.value ?? "";
}

async function handleSelfRoleComponent(env, interaction) {
  const role = interaction.data.custom_id.split(":")[1];
  const user = interactionUser(interaction);
  const hasRole = (interaction.member?.roles || []).includes(role);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${user.id}/roles/${role}`, {
    method: hasRole ? "DELETE" : "PUT"
  });
  return messageResponse(hasRole ? "Role removed." : "Role added.", true);
}

async function handleGiveawayComponent(env, interaction) {
  const giveaways = await getStored(env, "giveaways", {});
  const messageId = interaction.message?.id;
  const giveaway = giveaways[messageId];
  if (!giveaway) return messageResponse("Giveaway is no longer active.", true);
  const user = interactionUser(interaction);
  giveaway.entries ||= [];
  if (!giveaway.entries.includes(user.id)) giveaway.entries.push(user.id);
  giveaways[messageId] = giveaway;
  await putStored(env, "giveaways", giveaways);
  return messageResponse("Giveaway entry saved.", true);
}

export async function handleInteraction(request, env, ctx) {
  const rawBody = await request.text();
  if (!(await verifyDiscordRequest(request, env, rawBody))) return text("Invalid request signature.", 401);

  const interaction = JSON.parse(rawBody);
  if (interaction.type === INTERACTION_TYPE.PING) return pong();
  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE) {
    if (interaction.data.name === "gen") {
      return autocompleteResponse(await searchSteamSuggestions(focusedAutocompleteValue(interaction)));
    }
    return autocompleteResponse([]);
  }
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id || "";
    if (isManifestJobComponent(customId)) return handleManifestJobComponent(env, interaction, ctx);
    if (isTicketComponent(customId)) return handleTicketComponent(env, interaction, ctx);
    if (customId.startsWith("selfrole_toggle:")) return handleSelfRoleComponent(env, interaction);
    if (customId === "giveaway_enter") return handleGiveawayComponent(env, interaction);
    return messageResponse("Unsupported interaction.");
  }
  if (interaction.type === INTERACTION_TYPE.MODAL_SUBMIT) {
    const customId = interaction.data.custom_id || "";
    if (isManifestJobModal(customId)) return handleManifestJobModal(env, interaction, ctx);
    if (isTicketModal(customId)) return handleTicketModal(env, interaction, ctx);
    return messageResponse("Unsupported modal.");
  }
  if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) return messageResponse("Unsupported interaction.");

  if (interaction.data.name === "request") {
    ctx.waitUntil(handleManifestRequestCommand(env, interaction).catch((error) =>
      editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Request Failed", error.message || "Request failed.", DANGER)]
      }).catch(console.error)
    ));
    return deferredResponse(true);
  }

  if (interaction.data.name === "gen") {
    ctx.waitUntil(handleGenCommand(env, interaction).catch((error) =>
      editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Generation Failed", error.message || "Generation failed.", DANGER)]
      }).catch(console.error)
    ));
    return deferredResponse(false);
  }

  if (interaction.data.name === "fix") {
    ctx.waitUntil(handleFixCommand(env, interaction).catch((error) =>
      editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Repair Failed", error.message || "Repair request failed.", DANGER)]
      }).catch(console.error)
    ));
    return deferredResponse(true);
  }

  if (PUBLIC_COMMANDS.has(interaction.data.name)) {
    ctx.waitUntil(completeDeferredCommand(env, interaction));
    return deferredResponse(!["website", "vote"].includes(interaction.data.name));
  }

  if (TICKET_COMMANDS.has(interaction.data.name)) {
    ctx.waitUntil(completeDeferredCommand(env, interaction));
    return deferredResponse(false);
  }

  if (!(await canUseModeratorCommands(env, interaction))) {
    return messageResponse("You do not have permission.", true);
  }

  ctx.waitUntil(completeDeferredCommand(env, interaction));
  return deferredResponse(false);
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
