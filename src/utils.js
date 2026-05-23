export const DISCORD_API = "https://discord.com/api/v10";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

export function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) throw new Error("Invalid hex string.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function encodePathPart(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function joinUrl(base, fileName) {
  const cleanBase = String(base || "").replace(/\/+$/, "");
  const cleanFile = encodePathPart(fileName);
  return `${cleanBase}/${cleanFile}`;
}

export function normalizeBasePath(path) {
  return String(path || "").trim().replace(/^\/+|\/+$/g, "");
}

export function getConfiguredBasePaths(env) {
  const raw = env.DATABASE_BASE_PATHS ?? ",manifests";
  const paths = String(raw)
    .split(",")
    .map(normalizeBasePath);
  return [...new Set(paths)];
}

export function normalizeAppId(value) {
  const appId = String(value ?? "").trim();
  if (!/^\d+$/.test(appId)) throw new Error("Enter a valid numeric Steam App ID.");
  return appId;
}

export function normalizeUserId(value) {
  const userId = String(value ?? "").replace(/[<@!>]/g, "").trim();
  if (!/^\d{15,25}$/.test(userId)) throw new Error("Enter a valid Discord user ID.");
  return userId;
}

export function getOption(options = [], name) {
  return options.find((option) => option.name === name);
}

export function getOptionValue(options = [], name, fallback = undefined) {
  const option = getOption(options, name);
  return option?.value ?? fallback;
}

export function getSubcommand(data) {
  return data?.options?.find((option) => option.type === 1);
}

export function truncate(value, max = 1800) {
  const textValue = String(value ?? "");
  if (textValue.length <= max) return textValue;
  return `${textValue.slice(0, max - 1)}…`;
}

export function utcNow() {
  return new Date().toISOString();
}

export function snowflakeToDate(id) {
  const discordEpoch = 1420070400000n;
  const timestamp = (BigInt(id) >> 22n) + discordEpoch;
  return new Date(Number(timestamp)).toISOString();
}

export async function fetchWithTimeout(url, options = {}) {
  const { timeout = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    timeout: options.timeout ?? 10000,
    method: options.method,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    },
    body: options.body
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function storageCall(env, op, payload = {}) {
  if (!env.BOT_STORAGE) throw new Error("BOT_STORAGE Durable Object binding is missing.");
  const id = env.BOT_STORAGE.idFromName("global");
  const object = env.BOT_STORAGE.get(id);
  const response = await object.fetch("https://storage.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...payload })
  });
  if (!response.ok) throw new Error(`Storage failed: ${response.status}`);
  return response.json();
}

export function permissionBits(interaction) {
  try {
    return BigInt(interaction?.member?.permissions || "0");
  } catch {
    return 0n;
  }
}

export const PERMISSIONS = {
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
  MANAGE_ROLES: 0x10000000n,
  MANAGE_CHANNELS: 0x10n,
  MANAGE_MESSAGES: 0x2000n,
  KICK_MEMBERS: 0x2n,
  BAN_MEMBERS: 0x4n,
  MODERATE_MEMBERS: 0x10000000000n,
  SEND_MESSAGES: 0x800n
};

export function hasPermission(interaction, bit) {
  return (permissionBits(interaction) & bit) === bit;
}

export function isAdmin(interaction) {
  return hasPermission(interaction, PERMISSIONS.ADMINISTRATOR);
}

export function isManageServer(interaction) {
  return hasPermission(interaction, PERMISSIONS.MANAGE_GUILD);
}
