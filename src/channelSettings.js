import { storageCall } from "./utils.js";

export const CHANNEL_SETTING_TYPES = {
  request: {
    key: "channel.request",
    label: "Request/Fix Channel",
    env: "REQUEST_CHANNEL",
    fallback: "1507608145021632542"
  },
  log: {
    key: "channel.log",
    label: "Bot Log Channel",
    env: "MOD_LOG_CHANNEL",
    fallbackEnv: "REQUEST_CHANNEL",
    fallback: "1507608145021632542"
  },
  gen: {
    key: "channel.gen",
    label: "Generation Command Channel",
    env: "GEN_COMMAND_CHANNEL",
    fallback: ""
  },
  games: {
    key: "channel.games",
    label: "Games Added Channel",
    env: "GAMES_ADDED_CHANNEL",
    fallback: "1508749560669933648"
  },
  ticketlog: {
    key: "channel.ticketlog",
    label: "Ticket Log Channel",
    env: "TICKET_LOG_CHANNEL",
    fallback: "1485507520335446147"
  },
  genlog: {
    key: "channel.genlog",
    label: "Gen Log Channel",
    env: "GEN_LOG_CHANNEL",
    fallback: ""
  }
};

export function channelTypeNames() {
  return Object.keys(CHANNEL_SETTING_TYPES);
}

export async function getChannelSetting(env, type) {
  const config = CHANNEL_SETTING_TYPES[type];
  if (!config) throw new Error(`Unknown channel setting: ${type}`);

  try {
    const stored = await storageCall(env, "get", { key: config.key, fallback: "" });
    const value = String(stored.value || "").trim();
    if (value) return value;
  } catch {
    // Storage outages must not break command responses; env/default still works.
  }

  return String(env[config.env] || env[config.fallbackEnv] || config.fallback || "").trim();
}

export async function setChannelSetting(env, type, channelId) {
  const config = CHANNEL_SETTING_TYPES[type];
  if (!config) throw new Error(`Unknown channel setting: ${type}`);
  const clean = String(channelId || "").replace(/[<#>]/g, "").trim();
  if (!/^\d{15,25}$/.test(clean)) throw new Error("Choose a valid Discord channel.");
  await storageCall(env, "put", { key: config.key, value: clean });
  return clean;
}

export async function listChannelSettings(env) {
  const entries = [];
  for (const [type, config] of Object.entries(CHANNEL_SETTING_TYPES)) {
    entries.push({
      type,
      label: config.label,
      channelId: await getChannelSetting(env, type)
    });
  }
  return entries;
}

export async function requireCommandChannel(env, interaction, commandName) {
  if (!["gen", "request", "fix"].includes(commandName)) return;
  const channelId = await getChannelSetting(env, "gen");
  if (!channelId) return;
  if (String(interaction.channel_id || "") === channelId) return;
  throw new Error(`Use \`/${commandName}\` in <#${channelId}>.`);
}
