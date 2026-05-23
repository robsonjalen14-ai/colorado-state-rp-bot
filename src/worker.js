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
  resolvedUser,
  sendChannelMessage,
  storeAndSendModLog,
  verifyDiscordRequest
} from "./discord.js";
import { fetchGameDetails, formatGameDetails, lookupPackage } from "./github.js";
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

  const current = await storageCall(env, "get", { key: "requests", fallback: [] });
  const requests = Array.isArray(current.value) ? current.value : [];
  requests.unshift(requestEntry);
  await storageCall(env, "put", { key: "requests", value: requests.slice(0, 100) });

  await sendChannelMessage(env, env.REQUEST_CHANNEL, [
    "📥 New Request",
    "",
    `AppID: ${appId}`,
    "Requested By:",
    user.username,
    user.id,
    "",
    "Timestamp:",
    timestamp
  ].join("\n"));
}

async function handleGenCommand(env, interaction) {
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  await editOriginalInteraction(env, interaction, "⏳ Generating...");

  const [game, result] = await Promise.all([
    fetchGameDetails(appId),
    lookupPackage(env, appId)
  ]);

  if (!result) {
    await editOriginalInteraction(env, interaction, [
      `❌ No files found for AppID ${appId}`,
      "",
      formatGameDetails(game)
    ].join("\n"));
    return;
  }

  await editOriginalInteraction(env, interaction, [
    `✅ Generated for AppID ${appId}`,
    `Source: ${result.source}`,
    "",
    formatGameDetails(game)
  ].join("\n"), {
    filename: result.fileName || `${appId}.zip`,
    bytes: result.bytes,
    contentType: "application/zip"
  });
}

async function handleModCommand(env, interaction) {
  await requireModerator(env, interaction);
  const subcommand = getSubcommand(interaction.data);
  if (!subcommand) throw new Error("Missing subcommand.");
  const userIdRaw = getOptionValue(subcommand.options, "userid");
  const current = await storageCall(env, "get", { key: "moderators", fallback: [] });
  const moderators = Array.isArray(current.value) ? current.value : [];

  if (subcommand.name === "add") {
    const userId = normalizeUserId(userIdRaw);
    if (!moderators.includes(userId)) {
      moderators.push(userId);
      await storageCall(env, "put", { key: "moderators", value: moderators });
    }
    return "✅ Moderator added";
  }

  if (subcommand.name === "remove") {
    const userId = normalizeUserId(userIdRaw);
    await storageCall(env, "put", { key: "moderators", value: moderators.filter((id) => id !== userId) });
    return "✅ Moderator removed";
  }

  if (subcommand.name === "list") {
    return moderators.length
      ? `Moderators:\n${moderators.map((id) => `• <@${id}> (${id})`).join("\n")}`
      : "Moderators:\nNone";
  }

  throw new Error("Unknown mod subcommand.");
}

async function handleRequestsCommand(env, interaction) {
  await requireModerator(env, interaction);
  const data = await storageCall(env, "get", { key: "requests", fallback: [] });
  const requests = Array.isArray(data.value) ? data.value.slice(0, 10) : [];
  if (!requests.length) return "No requests yet.";
  return `Latest requests:\n${requests.map((request) =>
    `• AppID ${request.appid} - ${request.username || request.userId} - ${request.time}`
  ).join("\n")}`;
}

async function handleRequestDeleteCommand(env, interaction) {
  await requireModerator(env, interaction);
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  const data = await storageCall(env, "get", { key: "requests", fallback: [] });
  const requests = Array.isArray(data.value) ? data.value : [];
  await storageCall(env, "put", { key: "requests", value: requests.filter((request) => request.appid !== appId) });
  return "✅ Request removed";
}

async function handleAnnouncement(env, interaction) {
  await requireModerator(env, interaction);
  const message = String(getOptionValue(interaction.data.options, "message", "")).trim();
  if (!message) throw new Error("Announcement message is required.");
  await sendChannelMessage(env, env.REQUEST_CHANNEL, message);
  return "✅ Announcement sent";
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

async function handleKick(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.KICK_MEMBERS);
  const target = resolvedUser(interaction);
  const reason = getOptionValue(interaction.data.options, "reason", "Not provided");
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
  await logAction(env, interaction, "👢 KICK", `${target.user.username} (${target.userId})`, reason);
  return "✅ User kicked";
}

async function handleBan(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.BAN_MEMBERS);
  const target = resolvedUser(interaction);
  const reason = getOptionValue(interaction.data.options, "reason", "Not provided");
  const days = Number(getOptionValue(interaction.data.options, "days", 0));
  await assertCanModerateTarget(env, interaction, target);
  try {
    await discordApi(env, `/guilds/${interaction.guild_id}/bans/${target.userId}`);
    throw new Error("User is already banned.");
  } catch (error) {
    if (!String(error.message).includes("404")) throw error;
  }
  await discordApi(env, `/guilds/${interaction.guild_id}/bans/${target.userId}?reason=${encodeURIComponent(reason)}`, {
    method: "PUT",
    body: { delete_message_seconds: Math.max(0, Math.min(7, days)) * 86400 }
  });
  await logAction(env, interaction, "🔨 BAN", `${target.user.username} (${target.userId})`, reason);
  return "✅ User banned";
}

async function handleUnban(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.BAN_MEMBERS);
  const userId = normalizeUserId(getOptionValue(interaction.data.options, "userid"));
  await discordApi(env, `/guilds/${interaction.guild_id}/bans/${userId}`, { method: "DELETE" });
  await logAction(env, interaction, "♻️ UNBAN", userId, "Unbanned");
  return "✅ User unbanned";
}

async function handleMute(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MODERATE_MEMBERS);
  const target = resolvedUser(interaction);
  const duration = Number(getOptionValue(interaction.data.options, "duration"));
  const reason = getOptionValue(interaction.data.options, "reason", "Not provided");
  await assertCanModerateTarget(env, interaction, target);
  const member = await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`);
  if (member.communication_disabled_until && new Date(member.communication_disabled_until) > new Date()) {
    throw new Error("User is already muted.");
  }
  const until = new Date(Date.now() + duration * 60000).toISOString();
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}?reason=${encodeURIComponent(reason)}`, {
    method: "PATCH",
    body: { communication_disabled_until: until }
  });
  const data = await storageCall(env, "get", { key: "mutetimes", fallback: {} });
  const mutetimes = data.value && typeof data.value === "object" ? data.value : {};
  mutetimes[target.userId] = { until, reason, moderatorId: interactionUser(interaction).id };
  await storageCall(env, "put", { key: "mutetimes", value: mutetimes });
  await logAction(env, interaction, "🔇 MUTE", `${target.user.username} (${target.userId})`, `${reason} (${duration} min)`);
  return "🔇 User muted";
}

async function handleUnmute(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MODERATE_MEMBERS);
  const target = resolvedUser(interaction);
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`, {
    method: "PATCH",
    body: { communication_disabled_until: null }
  });
  const data = await storageCall(env, "get", { key: "mutetimes", fallback: {} });
  const mutetimes = data.value && typeof data.value === "object" ? data.value : {};
  delete mutetimes[target.userId];
  await storageCall(env, "put", { key: "mutetimes", value: mutetimes });
  await logAction(env, interaction, "🔊 UNMUTE", `${target.user.username} (${target.userId})`, "Unmuted");
  return "🔊 User unmuted";
}

async function warningsData(env) {
  const data = await storageCall(env, "get", { key: "warnings", fallback: {} });
  return data.value && typeof data.value === "object" ? data.value : {};
}

async function handleWarn(env, interaction) {
  await requireModerator(env, interaction);
  const target = resolvedUser(interaction);
  const reason = String(getOptionValue(interaction.data.options, "reason", "")).trim();
  await assertCanModerateTarget(env, interaction, target);
  const warnings = await warningsData(env);
  warnings[target.userId] ||= [];
  warnings[target.userId].unshift({ reason, moderatorId: interactionUser(interaction).id, time: utcNow() });
  await storageCall(env, "put", { key: "warnings", value: warnings });
  await logAction(env, interaction, "⚠️ WARN", `${target.user.username} (${target.userId})`, reason);
  return "⚠ Warning added";
}

async function handleWarnings(env, interaction) {
  await requireModerator(env, interaction);
  const target = resolvedUser(interaction);
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
  const target = resolvedUser(interaction);
  const warnings = await warningsData(env);
  delete warnings[target.userId];
  await storageCall(env, "put", { key: "warnings", value: warnings });
  await logAction(env, interaction, "✅ CLEAR WARNS", `${target.user.username} (${target.userId})`, "Warnings cleared");
  return "✅ Warnings cleared";
}

async function handlePurge(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_MESSAGES);
  const amount = Math.max(1, Math.min(100, Number(getOptionValue(interaction.data.options, "amount"))));
  const messages = await discordApi(env, `/channels/${interaction.channel_id}/messages?limit=${amount}`);
  const ids = messages.map((message) => message.id);
  if (ids.length === 1) {
    await discordApi(env, `/channels/${interaction.channel_id}/messages/${ids[0]}`, { method: "DELETE" });
  } else if (ids.length > 1) {
    await discordApi(env, `/channels/${interaction.channel_id}/messages/bulk-delete`, {
      method: "POST",
      body: { messages: ids }
    });
  }
  await logAction(env, interaction, "🧹 PURGE", interaction.channel_id, `${ids.length} messages`);
  return `🧹 Deleted ${ids.length} messages`;
}

async function handleSlowmode(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_CHANNELS);
  const seconds = Math.max(0, Math.min(21600, Number(getOptionValue(interaction.data.options, "seconds"))));
  await discordApi(env, `/channels/${interaction.channel_id}`, {
    method: "PATCH",
    body: { rate_limit_per_user: seconds }
  });
  await logAction(env, interaction, "⏱ SLOWMODE", interaction.channel_id, `${seconds}s`);
  return "⏱ Slowmode updated";
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
  await logAction(env, interaction, locked ? "🔒 LOCK" : "🔓 UNLOCK", interaction.channel_id, locked ? "Channel locked" : "Channel unlocked");
  return locked ? "🔒 Channel locked" : "🔓 Channel unlocked";
}

async function handleNick(env, interaction) {
  await requireModerator(env, interaction);
  assertCommandPermission(interaction, PERMISSIONS.MANAGE_ROLES);
  const target = resolvedUser(interaction);
  const nickname = String(getOptionValue(interaction.data.options, "nickname", "")).trim();
  await assertCanModerateTarget(env, interaction, target);
  await discordApi(env, `/guilds/${interaction.guild_id}/members/${target.userId}`, {
    method: "PATCH",
    body: { nick: nickname }
  });
  await logAction(env, interaction, "✏️ NICK", `${target.user.username} (${target.userId})`, nickname);
  return "✏ Nickname updated";
}

async function handleUserInfo(env, interaction) {
  await requireModerator(env, interaction);
  const target = resolvedUser(interaction);
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

async function handleModLogs(env, interaction) {
  await requireModerator(env, interaction);
  const data = await storageCall(env, "get", { key: "modlogs", fallback: [] });
  const logs = Array.isArray(data.value) ? data.value.slice(0, 10) : [];
  if (!logs.length) return "No moderation logs yet.";
  return truncate(logs.map((log) => auditMessage(log.action, log.moderator, log.target, log.reason, log.time)).join("\n\n"));
}

async function runCommand(env, interaction) {
  switch (interaction.data.name) {
    case "mod": return handleModCommand(env, interaction);
    case "requests": return handleRequestsCommand(env, interaction);
    case "request-delete": return handleRequestDeleteCommand(env, interaction);
    case "announce": return handleAnnouncement(env, interaction);
    case "kick": return handleKick(env, interaction);
    case "ban": return handleBan(env, interaction);
    case "unban": return handleUnban(env, interaction);
    case "mute": return handleMute(env, interaction);
    case "unmute": return handleUnmute(env, interaction);
    case "warn": return handleWarn(env, interaction);
    case "warnings": return handleWarnings(env, interaction);
    case "clearwarns": return handleClearWarns(env, interaction);
    case "purge": return handlePurge(env, interaction);
    case "slowmode": return handleSlowmode(env, interaction);
    case "lock": return setChannelLock(env, interaction, true);
    case "unlock": return setChannelLock(env, interaction, false);
    case "nick": return handleNick(env, interaction);
    case "userinfo": return handleUserInfo(env, interaction);
    case "serverinfo": return handleServerInfo(env, interaction);
    case "modlogs": return handleModLogs(env, interaction);
    default: throw new Error("Unknown command.");
  }
}

async function completeDeferredCommand(env, interaction) {
  try {
    const content = await runCommand(env, interaction);
    await editOriginalInteraction(env, interaction, content);
  } catch (error) {
    await editOriginalInteraction(env, interaction, error.message || "Command failed.");
  }
}

export async function handleInteraction(request, env, ctx) {
  const rawBody = await request.text();
  if (!(await verifyDiscordRequest(request, env, rawBody))) return text("Invalid request signature.", 401);

  const interaction = JSON.parse(rawBody);
  if (interaction.type === INTERACTION_TYPE.PING) return pong();
  if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) return messageResponse("Unsupported interaction.");

  if (interaction.data.name === "request") {
    ctx.waitUntil(handleRequestCommand(env, interaction).catch((error) => console.error("request failed", error)));
    return messageResponse("✅ Request submitted", true);
  }

  if (interaction.data.name === "gen") {
    ctx.waitUntil(handleGenCommand(env, interaction).catch((error) =>
      editOriginalInteraction(env, interaction, error.message || "Generation failed.").catch(console.error)
    ));
    return deferredResponse(false);
  }

  if (!(await canUseModeratorCommands(env, interaction))) {
    return messageResponse("❌ You do not have permission.", true);
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
  }
};
