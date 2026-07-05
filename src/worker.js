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
  sendInteractionFollowup,
  storeAndSendModLog,
  verifyDiscordRequest
} from "./discord.js";
import {
  createManifestEmbed,
  createNoResultsEmbed,
  createWebsiteEmbed,
  createGenLogEmbed,
  extractImageAccentColor,
  websiteButton
} from "./embeds.js";
import { autoPublishExternalManifest, autoPublishExternalPackage } from "./autoPublish.js";
import { backfillQueueStatus, processBackfillRetryQueue } from "./backfillQueue.js";
import { CHANNEL_SETTING_TYPES, getChannelSetting, listChannelSettings, requireCommandChannel, setChannelSetting } from "./channelSettings.js";
import { fetchGameDetails, lookupPackage, searchSteamSuggestions } from "./github.js";
import { healthCheck } from "./publisher.js";
import { findOnlineFix, onlineFixEmbed, onlineFixNotFoundEmbed } from "./onlineFix.js";
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
  handleAdminRoleSet,
  handleAdminAdd,
  handleAdminRemove,
  handleAdminList,
  handleAdminTransfer,
  handleAdminLogs,
  handleAdminPermissions,
  handleAdminAutocomplete
} from "./admin.js";
import {
  PERMISSIONS,
  getOption,
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

const MAX_DIRECT_INTERACTION_UPLOAD_BYTES = 10 * 1024 * 1024;

const SUCCESS = 0x05fff7;
const DANGER = 0xef4444;
const MOD = 0x8b5cf6;
const SITE_BACKFILL_ORIGINS = [
  "https://colorado-state-rp.vyro.workers.dev",
  "https://colorado-state-rp.co.in",
  "https://www.colorado-state-rp.co.in"
];

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const configuredOrigins = String(env.SITE_BACKFILL_ORIGINS || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const origins = configuredOrigins.length ? configuredOrigins : SITE_BACKFILL_ORIGINS;
  const allowOrigin = origins.includes(origin) ? origin : origins[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

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
      case "manifestChatUploadSessionStart": {
        const sessions = await this.state.storage.get("manifestChatUploadSessions") || {};
        const now = Date.now();
        for (const [userId, session] of Object.entries(sessions)) {
          if (!session?.expiresAt || Number(session.expiresAt) <= now) delete sessions[userId];
        }
        const existing = sessions[body.session?.userId];
        if (existing && Number(existing.expiresAt) > now) {
          await this.state.storage.put("manifestChatUploadSessions", sessions);
          return Response.json({ ok: false, reason: "ACTIVE", session: existing });
        }
        sessions[body.session.userId] = body.session;
        await this.state.storage.put("manifestChatUploadSessions", sessions);
        return Response.json({ ok: true, session: body.session });
      }
      case "manifestChatUploadSessionEnd": {
        const sessions = await this.state.storage.get("manifestChatUploadSessions") || {};
        const existing = sessions[body.userId];
        if (!existing || existing.id === body.sessionId) {
          delete sessions[body.userId];
          await this.state.storage.put("manifestChatUploadSessions", sessions);
        }
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
    footer: { text: "Colorado State RP Bot" }
  };
}

function messageEmbed(title, description, color = SUCCESS) {
  return {
    title,
    description: truncate(description || "Done.", 4000),
    color,
    timestamp: new Date().toISOString(),
    footer: { text: "Colorado State RP Bot" }
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
    footer: { text: "Colorado State RP Manifest Tool" }
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

function genWebsiteUrl(appId) {
  return `https://colorado-state-rp.vyro.workers.dev/colorado-state-rp-gen?appid=${encodeURIComponent(appId)}`;
}

function packageButtons(downloadUrl, appId) {
  const components = [];
  if (downloadUrl) {
    components.push({
      type: 2,
      style: 5,
      label: "Download ZIP",
      url: downloadUrl
    });
  }
  components.push({
    type: 2,
    style: 5,
    label: "Open on Colorado State RP Gen",
    url: genWebsiteUrl(appId)
  });
  return [{ type: 1, components }];
}

function byteCount(value) {
  return value?.byteLength ?? value?.length ?? 0;
}

function stablePackageDownloadUrl(result) {
  if (result?.downloadUrl) return result.downloadUrl;
  if (!result?.url) return "";
  if (["zip", "indexed-zip", "api", "api-link"].includes(result.kind)) return result.url;
  return "";
}

function helpEmbed() {
  return embed("Colorado State RP Help", [
    {
      name: "Manifest Tools",
      value: "`/gen appid` - Generate/download ZIP\n`/request appid` - Request a game\n`/website` - Open the Colorado State RP website\n`/admin manifest appid` - Check source availability",
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
  return embed("Colorado State RP Bot Status", [
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
    await sendInteractionFollowup(env, interaction, "", {
      embeds: [messageEmbed("Colorado State RP", result)]
    });
    return;
  }
  const embeds = [...(result.embeds || [])];
  if (result.content) embeds.unshift(messageEmbed("Colorado State RP", result.content));
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
  await dmUser(env, userId, `Colorado State RP Notice: ${action}`, [
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

  // Check for duplicate request by same user
  const existing = requests.find((r) => r.appid === appId && r.userId === user.id);
  if (existing) {
    throw new Error(`AppID ${appId} has already been requested. Check <#${await getChannelSetting(env, "request")}>.`);
  }

  requests.unshift(requestEntry);
  await putStored(env, "requests", requests.slice(0, 100));

  await sendChannelMessage(env, await getChannelSetting(env, "request"), "", {
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

// Daily generation limit helpers
const DAILY_GEN_LIMIT = 15;

function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function getGenLimitData(env, userId) {
  try {
    const stored = await getStored(env, `genlimit:${userId}`, null);
    if (!stored) {
      return { remaining: DAILY_GEN_LIMIT, date: todayDateStr() };
    }
    // Parse stored JSON
    const data = typeof stored === "string" ? JSON.parse(stored) : stored;
    const today = todayDateStr();
    // If it's a new day, reset
    if (data.date !== today) {
      return { remaining: DAILY_GEN_LIMIT, date: today };
    }
    return data;
  } catch {
    return { remaining: DAILY_GEN_LIMIT, date: todayDateStr() };
  }
}

async function setGenLimitData(env, userId, data) {
  await putStored(env, `genlimit:${userId}`, JSON.stringify(data));
}

async function decrementGenLimit(env, userId) {
  const data = await getGenLimitData(env, userId);
  if (data.remaining <= 0) return { remaining: 0, blocked: true };
  data.remaining = Math.max(0, data.remaining - 1);
  data.date = todayDateStr();
  await setGenLimitData(env, userId, data);
  return { remaining: data.remaining, blocked: false };
}

async function addGenLimit(env, userId, count) {
  const data = await getGenLimitData(env, userId);
  data.remaining = (data.remaining || 0) + count;
  data.date = todayDateStr();
  await setGenLimitData(env, userId, data);
  return data.remaining;
}

async function handleGenCommand(env, interaction, ctx = null) {
  const startedAt = Date.now();
  const appId = normalizeAppId(getOptionValue(interaction.data.options, "appid"));
  await editOriginalInteraction(env, interaction, "", null, {
    embeds: [messageEmbed("🔍 Searching Colorado State RP Repository...", "Please wait while the requested manifest package is located and verified.", MOD)],
  });

  // Check daily gen limit
  const userId = interactionUser(interaction)?.id;
  if (userId) {
    const limitData = await getGenLimitData(env, userId);
    if (limitData.remaining <= 0) {
      await sendInteractionFollowup(env, interaction, "", {
        embeds: [messageEmbed("⌛ Daily Generation Limit Reached", "You have used all your daily generations. Please wait until tomorrow for a refill.", DANGER)]
      });
      return;
    }
  }

  const [game, result] = await Promise.all([
    fetchGameDetails(appId),
    lookupPackage(env, appId, {
      waitUntil: (promise) => ctx?.waitUntil?.(promise)
    })
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
    manifestSource: result.manifestSource,
    manifestCount: result.manifestCount || 0,
    elapsedMs: Date.now() - startedAt,
    accentColor
  });

  // Decrement daily gen limit and notify user
  if (userId) {
    try {
      const updated = await decrementGenLimit(env, userId);
      if (!updated.blocked) {
        await sendInteractionFollowup(env, interaction, "", {
          embeds: [messageEmbed("", "⏱️ You have " + updated.remaining + " generations remaining today.", MOD)]
        });
      }
    } catch (limitErr) {
      console.log("[genlimit] Error: " + limitErr.message);
    }
  }

  // Send genlog to genlog channel if configured
  const genlog = async () => {
    try {
      const genlogChannel = await getChannelSetting(env, "genlog");
      if (!genlogChannel) return;
      
      const user = interactionUser(interaction);
      const userMention = user ? `<@${user.id}>` : "Unknown";
      
      if (result.source === "Used Colorado State RP Repo") {
        await sendChannelMessage(env, genlogChannel, "", {
          embeds: [createGenLogEmbed({
            game,
            source: result.source,
            manifestSource: result.manifestSource,
            manifestCount: result.manifestCount || 0,
            fileSize: result.fileSize || "",
            elapsedMs: Date.now() - startedAt,
            user: userMention,
            backfillStatus: `✅ Already in Database`,
            genType: "discord"
          })]
        });
      } else {
        // Genlog will be sent by autoPublishExternalPackage
      }
    } catch (genlogErr) {
      console.log(`[genlog] Error: ${genlogErr.message}`);
    }
  };
  
  ctx?.waitUntil?.(autoPublishExternalPackage(env, appId, result, game, {
    env,
    game,
    source: result.source,
    manifestSource: result.manifestSource,
    manifestCount: result.manifestCount || 0,
    fileSize: result.fileSize || "",
    elapsedMs: Date.now() - startedAt,
    user: (interactionUser(interaction) ? `<@${interactionUser(interaction).id}>` : "Unknown"),
    genType: "discord"
  }));
  ctx?.waitUntil?.(genlog());
  
  if (result.downloadUrl && !result.bytes) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [manifestEmbed],
      components: packageButtons(result.downloadUrl, appId)
    });
    return;
  }

  const packageBytes = byteCount(result.bytes);
  const directDownloadUrl = stablePackageDownloadUrl(result);
  if (packageBytes > MAX_DIRECT_INTERACTION_UPLOAD_BYTES) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [messageEmbed(
        "Package Too Large",
        `Colorado State RP found the package for AppID **${appId}**, but the generated ZIP is ${(packageBytes / 1024 / 1024).toFixed(1)} MB after bundling manifests. Open it in Colorado State RP Gen to generate and download it from the website.`,
        MOD
      )],
      components: packageButtons(null, appId)
    });
    return;
  }

  try {
    await editOriginalInteraction(env, interaction, "", {
      filename: result.fileName || `${appId}.zip`,
      bytes: result.bytes,
      contentType: "application/zip"
    }, {
      embeds: [manifestEmbed],
      components: packageButtons(null, appId),
      timeout: 90000
    });
  } catch (error) {
    if (!directDownloadUrl) throw error;
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [manifestEmbed],
      components: packageButtons(directDownloadUrl, appId)
    });
  }
}

async function handleOnlineFixCommand(env, interaction) {
  const gameName = String(commandOption(interaction, "game", "")).trim();
  if (!gameName) throw new Error("Enter a game name.");

  const result = await findOnlineFix(env, gameName);
  if (!result) {
    return { embeds: [onlineFixNotFoundEmbed(gameName)] };
  }

  return {
    embeds: [onlineFixEmbed(gameName, result)]
  };
}

async function handleAdminCommand(env, interaction) {
  var sub = subcommandName(interaction);
  // Handle subcommand groups
  var subOption = (interaction.data.options || []).find(function(o) { return o.type === 2; });
  if (subOption) {
    var subSub = (subOption.options || []).find(function(o) { return o.type === 1; });
    if (subSub) sub = subOption.name + '_' + subSub.name;
  }
  if (sub === 'role') return handleAdminRoleSet(env, interaction);
  if (sub === 'add') return handleAdminAdd(env, interaction);
  if (sub === 'remove') return handleAdminRemove(env, interaction);
  if (sub === 'list') return handleAdminList(env, interaction);
  if (sub === 'transfer') return handleAdminTransfer(env, interaction);
  if (sub === 'logs') return handleAdminLogs(env, interaction);
  if (sub === 'permissions') return handleAdminPermissions(env, interaction);
  if (sub === 'manifest') {
    var appId = getOptionValue(commandOptions(interaction), 'appid');
    if (!appId) throw new Error('AppID is required.');
    var [game, result] = await Promise.all([
      fetchGameDetails(appId),
      lookupPackage(env, appId, { includeBytes: false })
    ]);
    return {
      content: result ? `Manifest found for AppID ${appId}.` : `No manifest found for AppID ${appId}.`,
      embeds: [gameEmbed(game, result?.source || "Not found")]
    };
  }
  if (sub === 'genadd') {
    var rawTargetUser = getOptionValue(commandOptions(interaction), 'user');
    var count = parseInt(getOptionValue(commandOptions(interaction), 'count'), 10) || 1;
    var targetId = rawTargetUser ? String(rawTargetUser).replace(/[<@!>]/g, '').trim() : null;
    if (!targetId) throw new Error('User is required.');
    var newRemaining = await addGenLimit(env, targetId, count);
    await storeAndSendModLog(env, { action: 'Gen Limit Added', moderator: interactionUser(interaction), target: targetId, reason: '+' + count + ' generations' });
    return sendInteractionFollowup(env, interaction, 'Added ' + count + ' generations to <@' + targetId + '>. New remaining: ' + newRemaining);
  }
  throw new Error('Unknown admin subcommand: ' + sub);
}

async function handleChannelCommand(env, interaction) {
  if (!(await canUseModeratorCommands(env, interaction))) {
    throw new Error("You do not have permission.");
  }

  const action = subcommandName(interaction);
  if (action === "set") {
    const target = String(commandOption(interaction, "target") || "").trim();
    const channelId = String(commandOption(interaction, "channel") || "").trim();
    if (!CHANNEL_SETTING_TYPES[target]) throw new Error("Unknown channel setting.");
    const saved = await setChannelSetting(env, target, channelId);
    await storeAdminLog(env, "CHANNEL SET", interactionUser(interaction), target, `Set to ${saved}`);
    return {
      embeds: [messageEmbed("Channel Updated", `${CHANNEL_SETTING_TYPES[target].label} set to <#${saved}>.`, SUCCESS)]
    };
  }

  if (action === "list") {
    const channels = await listChannelSettings(env);
    return {
      embeds: [embed("Colorado State RP Channels", channels.map((item) => ({
        name: item.label,
        value: item.channelId ? `<#${item.channelId}> (${item.channelId})` : "Not set",
        inline: false
      })), MOD)]
    };
  }

  throw new Error("Unknown channel subcommand.");
}

async function enforceGenRequestFixChannel(env, interaction, commandName) {
  try {
    await requireCommandChannel(env, interaction, commandName);
  } catch (error) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [messageEmbed("Wrong Channel", error.message, DANGER)]
    });
    throw error;
  }
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
      footer: { text: "Colorado State RP Bot" }
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
  await sendFormattedChannelMessage(env, await getChannelSetting(env, "request"), message, sendFormatOptions(interaction));
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
  await notifyUserAction(env, interaction, target, "Warnings Cleared", "Your Colorado State RP warnings were cleared.");
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
  await sendChannelMessage(env, created.id, "Channel nuked and recreated by Colorado State RP.");
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
      footer: { text: "Colorado State RP Bot" }
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
      footer: { text: "Colorado State RP Bot" }
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
      footer: { text: "Colorado State RP Bot" },
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
  await sendChannelMessage(env, await getChannelSetting(env, "log"), "", {
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
    const subject = String(commandOption(interaction, "subject", "Colorado State RP Mail")).trim();
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
      value: `From: <@${item.from}>\nSubject: ${item.subject || "Colorado State RP Mail"}\n${truncate(item.message, 800)}`,
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
  await sendChannelMessage(env, await getChannelSetting(env, "log"), "", {
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
  const [moderators, welcome, roleconfig, tickets] = await Promise.all([
    getStored(env, "moderators", []),
    getStored(env, "welcome", {}),

    getStored(env, "roleconfig", {}),
    getStored(env, "tickets", [])
  ]);
  return {
    embeds: [embed("Settings", [
      { name: "Admins", value: String(Array.isArray(moderators) ? moderators.length : 0), inline: true },
      { name: "Welcome", value: welcome.channelId ? `<#${welcome.channelId}>` : "Disabled", inline: true },
      { name: "Autorole", value: roleconfig.autorole ? `<@&${roleconfig.autorole}>` : "None", inline: true },
      { name: "Tickets", value: String(Array.isArray(tickets) ? tickets.length : 0), inline: true }
    ], MOD)]
  };
}

async function handleReset(env, interaction) {
  await requireModerator(env, interaction);
  const area = String(getOptionValue(interaction.data.options, "area", "")).trim().toLowerCase();
  const allowed = new Set(["welcome", "roleconfig", "sticky"]);
  if (!allowed.has(area)) throw new Error("Area must be one of: welcome, roleconfig, sticky.");
  await putStored(env, area, area === "sticky" ? {} : {});
  return `${area} reset.`;
}

async function handleRefresh(env, interaction) {
  await requireModerator(env, interaction);
  await storageCall(env, "delete", { key: "manifestChatUploadSessions" });
  await processBackfillRetryQueue(env).catch(() => null);
  const [health, queue] = await Promise.all([
    healthCheck(env).catch((error) => ({ ok: false, errors: [error.message] })),
    backfillQueueStatus(env).catch((error) => ({ error: error.message }))
  ]);

  return {
    embeds: [embed("Bot Refreshed", [
      { name: "Runtime", value: "Transient upload sessions cleared.", inline: false },
      { name: "Health", value: health.ok ? "Online" : `Issue: ${(health.errors || []).join(", ") || "Unknown"}`, inline: true },
      { name: "Backfill Queue", value: String(queue.queuedBackfills ?? 0), inline: true }
    ], health.ok ? SUCCESS : DANGER)]
  };
}

async function runCommand(env, interaction) {
  switch (interaction.data.name) {
    case "help": return { embeds: [helpEmbed()] };
    case "botstatus": return { embeds: [await botStatusEmbed(env)] };
    case "ping": return { embeds: [pingEmbed(interaction)] };
    case "status": return handleManifestStatusCommand(env, interaction);
    case "website": return { embeds: [createWebsiteEmbed()], components: websiteButton() };
    case "onlinefix": return handleOnlineFixCommand(env, interaction);
    case "poll": return handlePoll(env, interaction);
    case "admin": return handleAdminCommand(env, interaction);
    case "channel": return handleChannelCommand(env, interaction);
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
    case "refresh": return handleRefresh(env, interaction);
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

  await processBackfillRetryQueue(env).catch((error) =>
    console.log(`[backfill-queue] scheduled retry failed: ${error.message}`)
  );
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
  "onlinefix",
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
  if (interaction.data.name === "onlinefix") {
    const suggestions = await searchSteamSuggestions(focusedAutocompleteValue(interaction));
    return autocompleteResponse(suggestions.map((s) => ({
      name: s.name,
      value: s.name.replace(/\s*\(\d+\)$/, "")
    })));
  }
  if (interaction.data.name === "admin") {
    return autocompleteResponse(await handleAdminAutocomplete(env, interaction));
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
    ctx.waitUntil((async () => {
      await enforceGenRequestFixChannel(env, interaction, "request");
      await handleManifestRequestCommand(env, interaction);
    })().catch((error) => {
      if (/^Use `\/request`/.test(error.message || "")) return;
      return editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Request Failed", error.message || "Request failed.", DANGER)]
      }).catch(console.error);
    }));
    return deferredResponse(true);
  }

  if (interaction.data.name === "gen") {
    ctx.waitUntil((async () => {
      await enforceGenRequestFixChannel(env, interaction, "gen");
      await handleGenCommand(env, interaction, ctx);
    })().catch((error) => {
      if (/^Use `\/gen`/.test(error.message || "")) return;
      return editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Generation Failed", error.message || "Generation failed.", DANGER)]
      }).catch(console.error);
    }));
    return deferredResponse(false);
  }

  if (interaction.data.name === "fix") {
    ctx.waitUntil((async () => {
      await enforceGenRequestFixChannel(env, interaction, "fix");
      await handleFixCommand(env, interaction);
    })().catch((error) => {
      if (/^Use `\/fix`/.test(error.message || "")) return;
      return editOriginalInteraction(env, interaction, "", null, {
        embeds: [messageEmbed("Repair Failed", error.message || "Repair request failed.", DANGER)]
      }).catch(console.error);
    }));
    return deferredResponse(true);
  }

  if (PUBLIC_COMMANDS.has(interaction.data.name)) {
    ctx.waitUntil(completeDeferredCommand(env, interaction));
    return deferredResponse(!["website", "vote", "onlinefix"].includes(interaction.data.name));
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

async function handleSiteBackfill(request, env) {
  const headers = corsHeaders(env, request);

  try {
    const payload = await request.json();

    if (payload?.type === "external-package") {
      const appId = normalizeAppId(payload.appId);
      const repositoryResult = await lookupPackage(env, appId);
      if (repositoryResult?.source !== "Used External API" || !repositoryResult.bytes?.length || repositoryResult.kind === "api-link") {
        return jsonResponse({
          ok: false,
          skipped: true,
          reason: repositoryResult ? "not-external-package" : "not-found"
        }, 200, headers);
      }

      const game = await fetchGameDetails(appId).catch(() => null);
      const published = await autoPublishExternalPackage(env, appId, repositoryResult, game, { env, game, source: repositoryResult.source, manifestSource: repositoryResult.manifestSource, manifestCount: repositoryResult.manifestCount || 0, elapsedMs: 0, user: "<@system>" });
      return jsonResponse({ ok: true, type: payload.type, appId, published }, 200, headers);
    }

    if (payload?.type === "manifest-vault") {
      const published = await autoPublishExternalManifest(env, payload.fileName);
      return jsonResponse({ ok: true, type: payload.type, published }, 200, headers);
    }

    return jsonResponse({ ok: false, error: "Unsupported backfill type." }, 400, headers);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message || "Backfill failed." }, 500, headers);
  }
}

async function handleSiteGenLog(request, env) {
  const headers = corsHeaders(env, request);

  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed." }, 405, headers);
    }

    const payload = await request.json();
    const appId = normalizeAppId(payload?.appId || payload?.game?.appId || "");
    const genlogChannel = await getChannelSetting(env, "genlog");
    if (!genlogChannel) {
      return jsonResponse({ ok: false, skipped: true, reason: "genlog-not-configured" }, 200, headers);
    }

    const game = payload.game && typeof payload.game === "object" ? { ...payload.game } : {};
    game.appId ||= appId;
    game.name ||= payload.gameName || `Steam App ${appId}`;
    game.banner ||= payload.banner || payload.header_image || payload.game?.header_image;
    if (payload.releaseDate && !game.releaseDate) game.releaseDate = payload.releaseDate;
    if (payload.publisher && !game.publishers) game.publishers = [payload.publisher];

    await sendChannelMessage(env, genlogChannel, "", {
      embeds: [createGenLogEmbed({
        game,
        source: payload.source || "",
        manifestSource: payload.manifestSource || "",
        manifestCount: payload.manifestCount || 0,
        fileSize: payload.fileSize || "",
        elapsedMs: payload.elapsedMs || 0,
        user: payload.user || (payload.genType === "app" ? "Colorado State RP App" : "Website"),
        backfillStatus: payload.backfillStatus || "Generation completed.",
        genType: payload.genType || "website"
      })]
    });

    return jsonResponse({ ok: true }, 200, headers);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message || "Gen log failed." }, 500, headers);
  }
}

async function handleHealth(request, env) {
  const headers = corsHeaders(env, request);
  const [health, queue] = await Promise.all([
    healthCheck(env).catch((error) => ({ ok: false, checks: {}, errors: [error.message] })),
    backfillQueueStatus(env).catch((error) => ({ error: error.message }))
  ]);
  return jsonResponse({
    ok: Boolean(health.ok),
    service: "Colorado State RP Bot",
    health,
    queue,
    time: new Date().toISOString()
  }, health.ok ? 200 : 503, headers);
}

async function handleSteamSuggest(request, env) {
  const url = new URL(request.url);
  const term = String(url.searchParams.get("term") || "").trim();
  if (!term || /^\d+$/.test(term)) {
    return jsonResponse({ ok: true, suggestions: [] }, 200, corsHeaders(env, request));
  }

  const suggestions = await searchSteamSuggestions(term).catch(() => []);
  return jsonResponse({ ok: true, suggestions }, 200, corsHeaders(env, request));
}

async function handleGameDetailsApi(request, env) {
  const url = new URL(request.url);
  const appId = normalizeAppId(url.searchParams.get("appid") || "");
  const game = await fetchGameDetails(appId);
  return jsonResponse({ ok: true, game }, 200, corsHeaders(env, request));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      }
      if (request.method !== "GET") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405, corsHeaders(env, request));
      }
      return handleHealth(request, env);
    }

    if (url.pathname === "/api/steam-suggest") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      }
      if (request.method !== "GET") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405, corsHeaders(env, request));
      }
      return handleSteamSuggest(request, env);
    }

    if (url.pathname === "/api/game-details") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      }
      if (request.method !== "GET") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405, corsHeaders(env, request));
      }
      try {
        return await handleGameDetailsApi(request, env);
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message || "Game details unavailable." }, 400, corsHeaders(env, request));
      }
    }

    if (url.pathname === "/api/backfill") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      }
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed." }, 405, corsHeaders(env, request));
      }
      return handleSiteBackfill(request, env, ctx);
    }

    if (url.pathname === "/api/gen-log") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      }
      return handleSiteGenLog(request, env);
    }

    if (request.method === "GET") {
      return text("Colorado State RP Discord bot is running.");
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
