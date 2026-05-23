import nacl from "tweetnacl";
import {
  DISCORD_API,
  PERMISSIONS,
  fetchJson,
  fetchWithTimeout,
  hasPermission,
  hexToBytes,
  isAdmin,
  isManageServer,
  json,
  snowflakeToDate,
  storageCall,
  truncate
} from "./utils.js";

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5
};

export const FLAGS = {
  EPHEMERAL: 1 << 6
};

export async function verifyDiscordRequest(request, env, body) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) return false;

  const message = new TextEncoder().encode(`${timestamp}${body}`);
  return nacl.sign.detached.verify(
    message,
    hexToBytes(signature),
    hexToBytes(env.DISCORD_PUBLIC_KEY)
  );
}

export function pong() {
  return json({ type: InteractionResponseType.PONG });
}

export function messageResponse(content, ephemeral = true) {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: truncate(content),
      flags: ephemeral ? FLAGS.EPHEMERAL : undefined
    }
  });
}

export function deferredResponse(ephemeral = true) {
  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: ephemeral ? FLAGS.EPHEMERAL : undefined
    }
  });
}

export async function discordApi(env, path, options = {}) {
  if (!env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is not configured.");
  const isFormData = options.body instanceof FormData;
  const headers = {
    Authorization: `Bot ${env.DISCORD_TOKEN}`,
    ...(options.headers || {})
  };
  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(`${DISCORD_API}${path}`, {
    timeout: options.timeout ?? 15000,
    method: options.method || "GET",
    headers,
    body: isFormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Discord API ${response.status}: ${truncate(errorText, 300)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function sendChannelMessage(env, channelId, content) {
  return discordApi(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: { content: truncate(content, 1900) }
  });
}

export async function editOriginalInteraction(env, interaction, content, file = null, options = {}) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  async function upload() {
    const payload = {
      content: truncate(content || "", file ? 1800 : 1900),
      embeds: options.embeds || [],
      attachments: file ? [{ id: 0, filename: file.filename }] : []
    };

    if (!file) {
      const response = await fetchWithTimeout(url, {
        method: "PATCH",
        timeout: 20000,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Interaction edit failed: HTTP ${response.status}`);
      return response.json();
    }

    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([file.bytes], { type: file.contentType || "application/zip" }), file.filename);

    const response = await fetchWithTimeout(url, {
      method: "PATCH",
      timeout: 30000,
      body: form
    });
    if (!response.ok) throw new Error(`Interaction upload failed: HTTP ${response.status}`);
    return response.json();
  }

  try {
    return await upload();
  } catch (error) {
    if (!file) throw error;
    return upload();
  }
}

export function interactionUser(interaction) {
  return interaction.member?.user || interaction.user;
}

export async function isStoredModerator(env, userId) {
  const data = await storageCall(env, "get", { key: "moderators", fallback: [] });
  return Array.isArray(data.value) && data.value.includes(userId);
}

export async function canUseModeratorCommands(env, interaction) {
  const user = interactionUser(interaction);
  if (!user) return false;
  return isAdmin(interaction) || isManageServer(interaction) || await isStoredModerator(env, user.id);
}

export function requireGuild(interaction) {
  if (!interaction.guild_id) throw new Error("This command can only be used in a server.");
}

export async function requireModerator(env, interaction) {
  requireGuild(interaction);
  if (!(await canUseModeratorCommands(env, interaction))) {
    throw new Error("❌ You do not have permission.");
  }
}

export function assertCommandPermission(interaction, permission) {
  if (!isAdmin(interaction) && !hasPermission(interaction, permission)) {
    throw new Error("❌ You do not have permission.");
  }
}

async function getGuild(env, guildId) {
  return discordApi(env, `/guilds/${guildId}?with_counts=true`);
}

async function getGuildRoles(env, guildId) {
  return discordApi(env, `/guilds/${guildId}/roles`);
}

async function getGuildMember(env, guildId, userId) {
  return discordApi(env, `/guilds/${guildId}/members/${userId}`);
}

function topRolePosition(roleIds = [], roles = []) {
  const roleMap = new Map(roles.map((role) => [role.id, role.position || 0]));
  return roleIds.reduce((highest, roleId) => Math.max(highest, roleMap.get(roleId) || 0), 0);
}

export function resolvedUser(interaction, optionName = "user") {
  const userId = interaction.data.options?.find((option) => option.name === optionName)?.value;
  const user = interaction.data.resolved?.users?.[userId];
  const member = interaction.data.resolved?.members?.[userId];
  if (!userId || !user) throw new Error("Target user was not resolved.");
  return { userId, user, member };
}

export async function assertCanModerateTarget(env, interaction, target, options = {}) {
  requireGuild(interaction);
  const moderator = interactionUser(interaction);
  if (!moderator) throw new Error("Moderator was not resolved.");
  if (target.userId === moderator.id) throw new Error("You cannot moderate yourself.");
  if (target.user?.bot || target.userId === env.DISCORD_APPLICATION_ID) throw new Error("You cannot moderate the bot.");
  if (options.skipHierarchy) return;

  const [guild, roles, botMember] = await Promise.all([
    getGuild(env, interaction.guild_id),
    getGuildRoles(env, interaction.guild_id),
    getGuildMember(env, interaction.guild_id, env.DISCORD_APPLICATION_ID)
  ]);

  let targetMember = target.member;
  if (!targetMember) {
    try {
      targetMember = await getGuildMember(env, interaction.guild_id, target.userId);
    } catch {
      targetMember = null;
    }
  }

  if (!targetMember) return;

  const moderatorTop = topRolePosition(interaction.member?.roles || [], roles);
  const targetTop = topRolePosition(targetMember.roles || [], roles);
  const botTop = topRolePosition(botMember.roles || [], roles);

  if (moderator.id !== guild.owner_id && targetTop >= moderatorTop) {
    throw new Error("You cannot moderate a member with an equal or higher role.");
  }
  if (targetTop >= botTop) {
    throw new Error("The bot role is not high enough to moderate this member.");
  }
}

export function auditMessage(action, moderator, target, reason, time) {
  return [
    action,
    "Moderator:",
    `${moderator.username || moderator.id} (${moderator.id})`,
    "",
    "Target:",
    target,
    "",
    "Reason:",
    reason || "Not provided",
    "",
    "Time:",
    time
  ].join("\n");
}

export async function storeAndSendModLog(env, entry) {
  const current = await storageCall(env, "get", { key: "modlogs", fallback: [] });
  const logs = Array.isArray(current.value) ? current.value : [];
  logs.unshift(entry);
  await storageCall(env, "put", { key: "modlogs", value: logs.slice(0, 100) });

  const channel = env.MOD_LOG_CHANNEL || env.REQUEST_CHANNEL;
  if (channel) {
    await sendChannelMessage(env, channel, auditMessage(entry.action, entry.moderator, entry.target, entry.reason, entry.time));
  }
}

export async function guildInfo(env, guildId) {
  const [guild, channels] = await Promise.all([
    getGuild(env, guildId),
    discordApi(env, `/guilds/${guildId}/channels`)
  ]);
  return { guild, channels };
}

export function formatMemberInfo(user, member, warnings = []) {
  const roles = member?.roles?.length ? member.roles.map((id) => `<@&${id}>`).join(", ") : "None";
  const timeoutUntil = member?.communication_disabled_until || "None";
  return [
    `Username: ${user.username || user.id}`,
    `User ID: ${user.id}`,
    `Created: ${snowflakeToDate(user.id)}`,
    `Joined: ${member?.joined_at || "Unknown"}`,
    `Roles: ${roles}`,
    `Warnings: ${warnings.length}`,
    `Timeout Until: ${timeoutUntil}`
  ].join("\n");
}
