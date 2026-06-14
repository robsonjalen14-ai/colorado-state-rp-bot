import { sendChannelMessage } from "./discord.js";
import { getChannelSetting } from "./channelSettings.js";
import { publishManifestVaultFile, publishNewManifest } from "./publisher.js";
import { fetchWithTimeout, joinUrl, truncate } from "./utils.js";
import { readZipEntries } from "./zip.js";

export const GAMES_ADDED_CHANNEL = "1508749560669933648";
const DEFAULT_FALLBACK_MANIFEST_REPOSITORIES = "https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main";

function safeList(value, fallback = "Unknown") {
  return Array.isArray(value) && value.length ? value.join(", ") : fallback;
}

function field(name, value, inline = true) {
  return { name, value: String(value || "Unknown"), inline };
}

export function createAutoPublishedGameEmbed({ appId, fileName, game }) {
  const hasMetadata = game?.name && game.name !== `Steam App ${appId}`;
  const embed = {
    color: 0x22c55e,
    title: hasMetadata ? "🎮 NEW GAME ADDED" : "🎮 New Manifest Added",
    description: hasMetadata
      ? "A new manifest has been published to Charon."
      : undefined,
    fields: hasMetadata ? [
      field("🎯 Game", truncate(game.name, 240), true),
      field("🆔 App ID", `\`${appId}\``, true),
      field("🏢 Developer", truncate(safeList(game.developers), 240), true),
      field("🚀 Publisher", truncate(safeList(game.publishers), 240), true),
      field("📅 Release Date", game.releaseDate || "Unknown", true),
      field("🎲 Genres", truncate(safeList(game.genres?.slice?.(0, 6) || game.genres), 240), true),
      field("📦 Manifest", `\`${fileName}\``, true),
      field("⬆ Uploaded By", "Charon Bot", true),
      field("☁ Published", "✅ Database 1\n✅ Database 2", false)
    ] : [
      field("App ID", `\`${appId}\``, true),
      field("File", `\`${fileName}\``, true),
      field("Uploader", "Charon Bot", true)
    ],
    footer: { text: "Powered by Charon" },
    timestamp: new Date().toISOString()
  };

  if (game?.banner) {
    embed.image = { url: game.banner };
  }

  return embed;
}

export async function autoPublishExternalPackage(env, appId, result, game = null) {
  if (!result || result.source !== "Used External API" || !result.bytes?.length || result.kind === "api-link") {
    return { published: false, reason: "not-external-package" };
  }

  const fileName = result.fileName || `${appId}.zip`;

  try {
    const published = await publishNewManifest(env, appId, fileName, result.bytes, "Charon Bot");
    const manifestBackfill = await publishBundledManifestsToVault(env, result.bytes);
    await sendChannelMessage(env, await getChannelSetting(env, "games") || GAMES_ADDED_CHANNEL, "", {
      embeds: [createAutoPublishedGameEmbed({ appId, fileName, game })]
    });
    return { published: true, paths: published.paths, manifestBackfill };
  } catch (error) {
    console.log(`[auto-publish] External package backfill skipped for AppID ${appId}: ${error.message}`);
    return { published: false, error: error.message };
  }
}

function parseUrlList(value, fallback = "") {
  return String(value || fallback || "")
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function normalizeManifestFileName(fileName) {
  const clean = String(fileName || "").split(/[\\/]/).filter(Boolean).pop() || "";
  if (!/^\d+_\d+\.manifest$/i.test(clean)) {
    throw new Error(`Invalid manifest filename: ${fileName}`);
  }
  return clean;
}

async function publishBundledManifestsToVault(env, zipBytes) {
  const uploaded = [];
  const skipped = [];
  const seen = new Set();

  let entries = [];
  try {
    entries = readZipEntries(zipBytes);
  } catch (error) {
    console.log(`[auto-publish] ZIP manifest scan skipped: ${error.message}`);
    return { uploaded, skipped, error: error.message };
  }

  for (const entry of entries) {
    if (!/\.manifest$/i.test(entry.name || "")) continue;

    let cleanFileName;
    try {
      cleanFileName = normalizeManifestFileName(entry.name);
    } catch {
      skipped.push({ fileName: entry.name, reason: "invalid-name" });
      continue;
    }

    const key = cleanFileName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const result = await publishManifestVaultFile(env, cleanFileName, entry.bytes, "External API ZIP");
      if (result?.uploaded) {
        uploaded.push({ fileName: cleanFileName, path: result.path });
      } else {
        skipped.push({ fileName: cleanFileName, reason: result?.reason || "not-uploaded" });
      }
    } catch (error) {
      skipped.push({ fileName: cleanFileName, reason: error.message || "upload-failed" });
    }
  }

  return { uploaded, skipped };
}

export async function autoPublishExternalManifest(env, fileName) {
  const cleanFileName = normalizeManifestFileName(fileName);
  const repositories = parseUrlList(
    env.MANIFEST_FALLBACK_URLS || env.FALLBACK_MANIFEST_REPOSITORIES,
    DEFAULT_FALLBACK_MANIFEST_REPOSITORIES
  );

  for (const repository of repositories) {
    const url = joinUrl(repository, cleanFileName);
    try {
      const response = await fetchWithTimeout(url, {
        timeout: 20000,
        headers: { Accept: "application/octet-stream, text/plain, */*" },
        cf: { cacheTtl: 0 }
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || !bytes.length) continue;
      const published = await publishManifestVaultFile(env, cleanFileName, bytes, "External Vault");
      return { published: true, fileName: cleanFileName, source: url, result: published };
    } catch (error) {
      console.log(`[auto-publish] External manifest source skipped for ${cleanFileName}: ${error.message}`);
    }
  }

  return { published: false, fileName: cleanFileName, reason: "not-found" };
}
