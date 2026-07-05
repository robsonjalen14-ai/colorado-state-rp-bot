import jpeg from "jpeg-js";
import { fetchWithTimeout, truncate } from "./utils.js";

export const BRAND = {
  name: "Colorado State RP Manifest Tool",
  cyan: 0x05fff7,
  purple: 0x8b5cf6,
  neutral: 0x2f3441
};

const WEBSITE_URL = "https://colorado-state-rp.vyro.workers.dev/";
const WEBSITE_LOGO_URL = "https://colorado-state-rp.vyro.workers.dev/images/icon-512.png";

function safeText(value, fallback = "Unknown") {
  const text = String(value || "").trim();
  return text || fallback;
}

function publisherText(game) {
  return Array.isArray(game?.publishers) && game.publishers.length
    ? game.publishers.join(", ")
    : "Publisher unavailable";
}

function releaseText(game) {
  const release = safeText(game?.releaseDate);
  return release === "Unknown" ? "Release unavailable" : release;
}

function sourceLabel(source) {
  if (/external/i.test(source || "")) return "External API";
  if (/colorado-state-rp|repo/i.test(source || "")) return "Colorado State RP Repo";
  return safeText(source, "Source ready");
}

function badge(value) {
  return `\`${value}\``;
}

function elapsedText(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return BRAND.name;
  const seconds = Math.max(0.1, elapsedMs / 1000);
  return `${BRAND.name} • ${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToInt(r, g, b) {
  return (clampByte(r) << 16) + (clampByte(g) << 8) + clampByte(b);
}

function vividColor(r, g, b) {
  const avg = (r + g + b) / 3;
  return [
    avg + (r - avg) * 1.22,
    avg + (g - avg) * 1.22,
    avg + (b - avg) * 1.22
  ];
}

function colorScore(r, g, b, count) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max - min;
  const brightness = (max + min) / 2;
  const balancedBrightness = 1 - Math.abs(140 - brightness) / 140;
  return count * (1 + saturation / 72) * Math.max(0.2, balancedBrightness);
}

function dominantColorFromRgba(data, width, height, fallback = BRAND.purple) {
  if (!data?.length || !width || !height) return fallback;

  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(Math.sqrt(pixelCount / 1800)));
  const buckets = new Map();

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 160) continue;

      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const brightness = (max + min) / 2;
      const saturation = max - min;

      if (brightness < 32 || brightness > 236 || saturation < 18) continue;

      const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
  }

  let best = null;
  let bestScore = 0;
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.count;
    const g = bucket.g / bucket.count;
    const b = bucket.b / bucket.count;
    const score = colorScore(r, g, b, bucket.count);
    if (score > bestScore) {
      bestScore = score;
      best = [r, g, b];
    }
  }

  if (!best) return fallback;
  const [r, g, b] = vividColor(...best);
  return rgbToInt(r, g, b);
}

function fallbackAccent(seed = "") {
  const palette = [BRAND.cyan, BRAND.purple, 0x22c55e, 0xf472b6, 0x38bdf8];
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export async function extractImageAccentColor(imageUrl, seed = "") {
  if (!imageUrl) return fallbackAccent(seed);
  try {
    const response = await fetchWithTimeout(imageUrl, {
      timeout: 8000,
      headers: { Accept: "image/jpeg,image/*;q=0.8" }
    });
    if (!response.ok) return fallbackAccent(seed);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 24 });
    return dominantColorFromRgba(decoded.data, decoded.width, decoded.height, fallbackAccent(seed));
  } catch {
    return fallbackAccent(seed);
  }
}

export function createManifestEmbed({ game, source, manifestSource, manifestCount, elapsedMs, accentColor }) {
  const appId = safeText(game?.appId);
  const title = safeText(game?.name, `Steam App ${appId}`);
  const publisher = publisherText(game);
  const release = releaseText(game);
  const sourceName = sourceLabel(source);

  const lines = [];
  lines.push(`🎮 **${truncate(title, 220)}**`);
  lines.push(`🏢 ${truncate(publisher, 240)}`);
  lines.push("");
  lines.push("─────────────────");
  lines.push("");
  lines.push("📋 **Information**");
  lines.push("");
  lines.push(`🔔 App ID: ${appId}`);
  lines.push(`📅 Release Date: ${release}`);
  lines.push("");
  lines.push("📚 **Source**");
  lines.push("");
  lines.push(`⚡ ${sourceName}`);
  if (manifestSource) lines.push(`📦 ${manifestSource}`);
  lines.push("");
  lines.push("─────────────────");
  if (manifestCount > 0) {
    lines.push("");
    lines.push("📁 **Bundle**");
    lines.push("");
    lines.push(`📦 ${manifestCount} Manifest File${manifestCount === 1 ? "" : "s"} Bundled`);
    lines.push("");
    lines.push("─────────────────");
  }

  const embed = {
    title: "📦 Manifest Package Ready",
    description: lines.join("\n"),
    color: accentColor || fallbackAccent(appId),
    timestamp: new Date().toISOString(),
    footer: { text: elapsedText(elapsedMs) }
  };

  if (game?.banner) {
    embed.image = { url: game.banner };
  }

  return embed;
}
export function createNoResultsEmbed(appId) {
  return {
    title: "🔍 Nothing Available Yet",
    description: [
      "No downloadable package is currently available.",
      "",
      badge(`🎮 AppID ${appId}`),
      "",
      "No Lua/Manifest files with this App ID were found across the database.",
      "",
      "If this is a valid Steam AppID, you can request support for it.",
      "",
      "Use:",
      `\`/request appid:${appId}\``,
      "",
      "_Requested files may appear later._"
    ].join("\n"),
    color: BRAND.neutral,
    timestamp: new Date().toISOString(),
    footer: { text: BRAND.name }
  };
}

export function createWebsiteEmbed() {
  return {
    title: "🌐 COLORADO STATE RP WEBSITE",
    url: WEBSITE_URL,
    description: [
      "Everything Colorado State RP in one place.",
      "",
      "━━━━━━━━━━━━━━",
      "📦 Download Colorado State RP",
      "⚙️ Use Colorado State RP Gen",
      "📖 Read the Guide",
      "💬 Join the Community",
      "━━━━━━━━━━━━━━",
      "",
      "**Click below to open the website.**"
    ].join("\n"),
    color: 0x5865f2,
    thumbnail: { url: WEBSITE_LOGO_URL },
    timestamp: new Date().toISOString(),
    footer: { text: "Powered by Colorado State RP" }
  };
}


export function createGenLogEmbed({ game, source, manifestSource, manifestCount, elapsedMs, user, backfillStatus, genType, fileSize }) {
  const appId = safeText(game?.appId);
  const title = safeText(game?.name, `Steam App ${appId}`);
  const publisher = publisherText(game);
  const release = releaseText(game);
  const sourceName = sourceLabel(source);

  const seconds = Math.max(0.1, elapsedMs / 1000);
  const timeText = `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;

  const lines = [];
  lines.push(`\uD83C\uDFAE **${truncate(title, 220)}**`);
  lines.push(`\uD83C\uDFE2 ${truncate(publisher, 240)}`);
  lines.push(`\uD83D\uDCC5 ${release}`);
  lines.push("");
  lines.push("\uD83D\uDCDA **Source**");
  lines.push(`\u26A1 ${sourceName}`);
  if (manifestSource) lines.push(`\uD83D\uDCE6 ${manifestSource}`);
  if (manifestCount > 0) lines.push(`\uD83D\uDCC1 ${manifestCount} Manifest File${manifestCount === 1 ? "" : "s"}`);
  if (fileSize) lines.push(`\uD83D\uDCE6 ${fileSize}`);
  lines.push("");
  lines.push("\u23F1 **Time**");
  lines.push(`\uD83D\uDD50 ${timeText}`);
  lines.push(`\uD83D\uDC64 ${user}`);
  lines.push("");
  lines.push("\uD83D\uDCE4 **Backfill**");
  lines.push(backfillStatus);

  const embed = {
    author: {
      name: genType === "website" ? "Website Gen" : genType === "app" ? "App Gen" : "Discord Gen",
      icon_url: WEBSITE_LOGO_URL
    },
    description: lines.join("\n"),
    color: BRAND.cyan,
    timestamp: new Date().toISOString(),
    footer: { text: `Gen Log - ${BRAND.name}` }
  };

  if (game?.banner) {
    embed.thumbnail = { url: game.banner };
  }

  return embed;
}


export function websiteButton() {
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: "🌐 Visit Website",
      url: WEBSITE_URL
    }]
  }];
}
