import { sendChannelMessage } from "./discord.js";
import { publishNewManifest } from "./publisher.js";
import { truncate } from "./utils.js";

export const GAMES_ADDED_CHANNEL = "1508749560669933648";

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
    await sendChannelMessage(env, env.GAMES_ADDED_CHANNEL || GAMES_ADDED_CHANNEL, "", {
      embeds: [createAutoPublishedGameEmbed({ appId, fileName, game })]
    });
    return { published: true, paths: published.paths };
  } catch (error) {
    console.log(`[auto-publish] External package backfill skipped for AppID ${appId}: ${error.message}`);
    return { published: false, error: error.message };
  }
}
