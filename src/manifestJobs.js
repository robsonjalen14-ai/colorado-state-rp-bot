import {
  discordApi,
  deferredResponse,
  editOriginalInteraction,
  interactionUser,
  isStoredModerator,
  messageResponse,
  modalResponse,
  sendChannelMessage,
  sendInteractionFollowup
} from "./discord.js";
import {
  fetchGameDetails,
  lookupRepositoryPackage
} from "./github.js";
import { getChannelSetting } from "./channelSettings.js";
import {
  countDatabaseFiles,
  publishFixManifest,
  publishNewManifest,
  publishReplacingManifest
} from "./publisher.js";
import {
  fetchWithTimeout,
  normalizeAppId,
  storageCall,
  truncate,
  utcNow
} from "./utils.js";

const REQUEST_CHANNEL_FALLBACK = "1507608145021632542";
const BLURPLE = 0x5865f2;
const ORANGE = 0xf59e0b;
const GREEN = 0x57f287;
const RED = 0xed4245;
const DARK = 0x2b2d31;
const CHAT_UPLOAD_WINDOW_MS = 60000;
const CHAT_UPLOAD_POLL_MS = 2500;
const DEFAULT_CHAT_UPLOAD_MAX_BYTES = 95 * 1024 * 1024;

const COMPONENT = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_INPUT: 4
};

const BUTTON = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4
};

const INPUT = {
  SHORT: 1
};

export const MANIFEST_JOB_COMMANDS = new Set([
  "fix",
  "claim",
  "unclaim",
  "queue",
  "cancel",
  "stats"
]);

async function requestChannel(env) {
  return await getChannelSetting(env, "request") || REQUEST_CHANNEL_FALLBACK;
}

async function gamesAddedChannel(env) {
  return await getChannelSetting(env, "games");
}

function actionRow(components) {
  return { type: COMPONENT.ACTION_ROW, components };
}

function button(customId, label, style, emoji, disabled = false) {
  return {
    type: COMPONENT.BUTTON,
    custom_id: customId,
    label,
    style,
    emoji: emoji ? { name: emoji } : undefined,
    disabled
  };
}

function uploadButton(job, disabled = false, complete = false) {
  const components = [
    button(
      `manifest_upload:${job.id}`,
      complete ? "Uploaded" : job.type === "fix" ? "Upload Fix" : "Upload File",
      complete ? BUTTON.SUCCESS : job.type === "fix" ? BUTTON.SECONDARY : BUTTON.PRIMARY,
      complete ? "✔" : job.type === "fix" ? "🛠" : "⬆",
      disabled
    )
  ];

  if (!complete) {
    components.push(button(
      `manifest_upload_chat:${job.id}`,
      "Upload Via Chat",
      BUTTON.PRIMARY,
      "📤",
      disabled
    ));
  }

  return [actionRow(components)];
}

function userMention(id) {
  return `<@${id}>`;
}

function timestamp(value = Date.now()) {
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${seconds}:R>`;
}

function absoluteTimestamp(value = Date.now()) {
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${seconds}:F>`;
}

function field(name, value, inline = false) {
  return { name, value: String(value || "Unknown"), inline };
}

function gameThumb(embed, game) {
  if (game?.banner) embed.thumbnail = { url: game.banner };
  return embed;
}

function largeGameImage(embed, game) {
  if (game?.banner) embed.image = { url: game.banner };
  return embed;
}

function allowedUploads(appId) {
  return `\`${appId}.zip\`\n\`${appId}.lua\``;
}

async function getStored(env, key, fallback) {
  const data = await storageCall(env, "get", { key, fallback });
  return data.value ?? fallback;
}

async function putStored(env, key, value) {
  await storageCall(env, "put", { key, value });
}

async function jobs(env) {
  const value = await getStored(env, "manifestJobs", []);
  return Array.isArray(value) ? value : [];
}

async function saveJobs(env, value) {
  await putStored(env, "manifestJobs", value.slice(0, 1000));
}

async function history(env) {
  const value = await getStored(env, "manifestHistory", []);
  return Array.isArray(value) ? value : [];
}

async function addHistory(env, entry) {
  const current = await history(env);
  current.unshift({ ...entry, time: utcNow() });
  await putStored(env, "manifestHistory", current.slice(0, 1000));
}

async function nextId(env) {
  const current = Number(await getStored(env, "manifestJobCounter", 0)) + 1;
  await putStored(env, "manifestJobCounter", current);
  return String(current);
}

async function updateJob(env, jobId, updater) {
  const current = await jobs(env);
  const index = current.findIndex((job) => String(job.id) === String(jobId));
  if (index === -1) throw new Error("Job not found.");
  current[index] = await updater({ ...current[index] });
  current[index].updatedAt = utcNow();
  await saveJobs(env, current);
  return current[index];
}

async function findJob(env, id) {
  return (await jobs(env)).find((job) => String(job.id) === String(id)) || null;
}

async function startChatUploadSession(env, session) {
  return storageCall(env, "manifestChatUploadSessionStart", { session });
}

async function endChatUploadSession(env, sessionId, userId) {
  return storageCall(env, "manifestChatUploadSessionEnd", { sessionId, userId }).catch(() => ({ ok: false }));
}

async function latestJobForApp(env, appId) {
  return (await jobs(env))
    .filter((job) => job.appId === appId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())[0] || null;
}

async function requireBotAdmin(env, interaction) {
  const user = interactionUser(interaction);
  if (!(await isStoredModerator(env, user.id))) {
    throw new Error("You do not have permission.");
  }
}

function baseJobEmbed(job, game, options = {}) {
  const isFix = job.type === "fix";
  const embed = {
    color: options.color ?? (isFix ? ORANGE : BLURPLE),
    title: options.title ?? (isFix ? "🛠 Manifest Repair Request" : "📥 New Manifest Request"),
    description: options.description ?? (isFix
      ? "A repair request has been submitted.\n\nThis operation may update or replace manifests inside Charon repositories."
      : "A new request has entered the Charon queue."),
    fields: [
      field(isFix ? "🆔 App ID" : "Requested App ID", `\`${job.appId}\``, true),
      field("Job ID", `\`${job.id}\``, true),
      field("Requester", userMention(job.requesterId), true),
      field(isFix ? "📎 Accepted Uploads" : "Accepted Upload Types", allowedUploads(job.appId), false),
      field("Rules", isFix
        ? "• Filename must equal App ID\n• One successful upload only\n• Automatic publishing\n• Existing manifests may be replaced"
        : "• Filename must match App ID\n• One successful upload only\n• Automatic publishing\n• No overwrite", false)
    ],
    footer: { text: options.footer ?? (isFix ? "Waiting for repair upload…" : "Waiting for upload…") },
    timestamp: new Date().toISOString()
  };
  return gameThumb(embed, game);
}

function alreadyAvailableEmbed(appId, game) {
  return gameThumb({
    color: ORANGE,
    title: "📦 Manifest Already Available",
    description: "Charon checked both repositories and found existing manifest files for this App ID.",
    fields: [
      field("App ID", `\`${appId}\``, true),
      field("Next Action", `If the existing manifest is outdated, broken, or needs replacing:\n\n\`/fix appid:${appId}\``, false)
    ],
    footer: { text: "No request was created" },
    timestamp: new Date().toISOString()
  }, game);
}

function uploadRejectedEmbed(appId, repair = false) {
  return {
    color: RED,
    title: repair ? "❌ Repair Upload Rejected" : "❌ Upload Rejected",
    description: repair
      ? "Uploaded filename must match the requested App ID."
      : "File name does not match request.",
    fields: [
      field("Allowed", allowedUploads(appId), false)
    ],
    footer: { text: repair ? "Repair cancelled" : "Nothing uploaded" },
    timestamp: new Date().toISOString()
  };
}

function alreadyCompletedEmbed(repair = false) {
  return {
    color: ORANGE,
    title: repair ? "⚠ Repair Already Completed" : "⚠ Request Already Completed",
    description: repair
      ? "This repair request was already fulfilled."
      : "This request has already been fulfilled.",
    timestamp: new Date().toISOString()
  };
}

function publishFailedEmbed() {
  return {
    color: RED,
    title: "⚠ Publish Failed",
    description: "Upload could not be completed.\n\nNothing was saved.",
    timestamp: new Date().toISOString()
  };
}

function completedEmbed(job, game) {
  const isFix = job.type === "fix";
  return gameThumb({
    color: GREEN,
    title: isFix ? "🛠 Manifest Repaired" : "✅ Manifest Published",
    description: isFix ? "Repair completed successfully." : "Upload completed successfully.",
    fields: [
      field(isFix ? "🆔 App ID" : "App ID", `\`${job.appId}\``, true),
      field(isFix ? "📦 Published File" : "File", `\`${job.fileName}\``, true),
      field(isFix ? "⬆ Fixed By" : "Uploaded By", userMention(job.uploadedBy), true),
      field(isFix ? "☁ Updated" : "Published", "✅ Database 1\n✅ Database 2", false)
    ],
    footer: { text: isFix ? "Repository repair completed" : "Request fulfilled successfully" },
    timestamp: new Date().toISOString()
  }, game);
}

function announcementEmbed(job, game) {
  const isFix = job.type === "fix";
  const hasMetadata = game?.name && game.name !== `Steam App ${job.appId}`;
  const embed = {
    color: isFix ? ORANGE : GREEN,
    title: hasMetadata ? (isFix ? "🛠 GAME FIX PUBLISHED" : "🎮 NEW GAME ADDED") : (isFix ? "🛠 Manifest Updated" : "🎮 New Manifest Added"),
    description: hasMetadata
      ? (isFix ? "A manifest repair has been published to Charon." : "A new manifest has been published to Charon.")
      : undefined,
    fields: hasMetadata ? [
      field("🎯 Game", game.name, true),
      field("🆔 App ID", `\`${job.appId}\``, true),
      field("🏢 Developer", game.developers?.length ? game.developers.join(", ") : "Unknown", true),
      field("🚀 Publisher", game.publishers?.length ? game.publishers.join(", ") : "Unknown", true),
      field("📅 Release Date", game.releaseDate || "Unknown", true),
      field("🎲 Genres", game.genres?.length ? game.genres.slice(0, 6).join(", ") : "Unknown", true),
      field(isFix ? "📦 Published Manifest" : "📦 Manifest", `\`${job.fileName}\``, true),
      field(isFix ? "⬆ Fixed By" : "⬆ Uploaded By", userMention(job.uploadedBy), true),
      field(isFix ? "☁ Repository Updated" : "☁ Published", "✅ Database 1\n✅ Database 2", false)
    ] : [
      field("App ID", `\`${job.appId}\``, true),
      field("File", `\`${job.fileName}\``, true),
      field("Uploader", userMention(job.uploadedBy), true)
    ],
    footer: { text: isFix ? "Powered by Charon Repair System" : "Powered by Charon" },
    timestamp: new Date().toISOString()
  };
  return largeGameImage(embed, game);
}

function uploadModal(job) {
  return modalResponse(`manifest_upload_modal:${job.id}`, job.type === "fix" ? "Upload Fix" : "Upload Manifest", [
    actionRow([{
      type: COMPONENT.TEXT_INPUT,
      custom_id: "url",
      label: "Direct file URL",
      style: INPUT.SHORT,
      required: true,
      placeholder: `Paste a direct URL to ${job.appId}.zip or ${job.appId}.lua`,
      max_length: 1000
    }])
  ]);
}

function fileNameFromUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const part = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

export function normalizeAllowedUploadFileName(appId, fileName, options = {}) {
  const value = String(fileName || "");
  if (value !== value.trim()) return null;
  const expected = [`${appId}.zip`, `${appId}.lua`];
  const match = expected.find((name) => (
    options.caseInsensitive
      ? name.toLowerCase() === value.toLowerCase()
      : name === value
  ));
  return match || null;
}

function isAllowedFile(appId, fileName, options = {}) {
  return Boolean(normalizeAllowedUploadFileName(appId, fileName, options));
}

async function downloadUpload(url) {
  const response = await fetchWithTimeout(url, {
    timeout: 60000,
    headers: { Accept: "application/zip, text/plain, application/octet-stream, */*" }
  });
  if (!response.ok) throw new Error(`Upload download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function chatUploadMaxBytes(env) {
  const configured = Number(env.CHAT_UPLOAD_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CHAT_UPLOAD_MAX_BYTES;
}

function uploadSizeError(maxBytes) {
  return `❌ File is too large. Maximum allowed size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadChatAttachment(attachment, maxBytes) {
  if (Number(attachment.size || 0) > maxBytes) {
    throw new Error(uploadSizeError(maxBytes));
  }
  const bytes = await downloadUpload(attachment.url);
  if (bytes.byteLength > maxBytes) {
    throw new Error(uploadSizeError(maxBytes));
  }
  return bytes;
}

async function editRequestMessage(env, job, embeds, components) {
  if (!job.channelId || !job.messageId) return;
  await discordApi(env, `/channels/${job.channelId}/messages/${job.messageId}`, {
    method: "PATCH",
    body: {
      embeds,
      components: components || []
    }
  }).catch(() => null);
}

async function createJob(env, interaction, appId, type, game) {
  const user = interactionUser(interaction);
  const id = await nextId(env);
  const job = {
    id,
    type,
    appId,
    requesterId: user.id,
    requesterName: user.username,
    status: "PENDING",
    uploaded: false,
    claimedBy: null,
    createdAt: utcNow(),
    updatedAt: utcNow()
  };
  const targetChannel = await requestChannel(env);
  const sent = await sendChannelMessage(env, targetChannel, "", {
    embeds: [baseJobEmbed(job, game)],
    components: uploadButton(job)
  });
  job.channelId = targetChannel;
  job.messageId = sent.id;

  const current = await jobs(env);
  current.unshift(job);
  await saveJobs(env, current);
  await addHistory(env, {
    appId,
    jobId: id,
    type,
    action: type === "fix" ? "Repair request created" : "Request created",
    userId: user.id,
    status: "PENDING"
  });

  if (type === "request") {
    const oldRequests = await getStored(env, "requests", []);
    oldRequests.unshift({
      appid: appId,
      userId: user.id,
      username: user.username,
      time: job.createdAt,
      jobId: id
    });
    await putStored(env, "requests", oldRequests.slice(0, 100));
  }

  return job;
}

export async function handleManifestRequestCommand(env, interaction) {
  const appId = normalizeAppId(interaction.data.options?.find((option) => option.name === "appid")?.value);
  const [game, existing] = await Promise.all([
    fetchGameDetails(appId),
    lookupRepositoryPackage(env, appId, { includeBytes: false })
  ]);
  if (existing) {
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [alreadyAvailableEmbed(appId, game)]
    });
    return;
  }

  await createJob(env, interaction, appId, "request", game);
  await editOriginalInteraction(env, interaction, "", null, {
    embeds: [{
      color: GREEN,
      title: "✅ Request Created",
      description: "Your request has been submitted.\n\nOnce someone uploads a valid manifest,\nCharon will publish automatically.",
      footer: { text: "Charon Request System" },
      timestamp: new Date().toISOString()
    }]
  });
}

export async function handleFixCommand(env, interaction) {
  const appId = normalizeAppId(interaction.data.options?.find((option) => option.name === "appid")?.value);
  const game = await fetchGameDetails(appId);
  await createJob(env, interaction, appId, "fix", game);
  await editOriginalInteraction(env, interaction, "", null, {
    embeds: [{
      color: ORANGE,
      title: "🛠 Repair Request Submitted",
      description: "Upload the corrected manifest.",
      footer: { text: "Charon Repair System" },
      timestamp: new Date().toISOString()
    }]
  });
}

export function isManifestJobComponent(customId = "") {
  return customId.startsWith("manifest_upload:") ||
    customId.startsWith("manifest_upload_chat:") ||
    customId.startsWith("mail_close") ||
    customId.startsWith("mail_generate:") ||
    customId.startsWith("mail_fix:");
}

export function isManifestJobModal(customId = "") {
  return customId.startsWith("manifest_upload_modal:");
}

export async function handleManifestJobComponent(env, interaction, ctx) {
  const customId = interaction.data.custom_id || "";
  if (customId === "mail_close") {
    return messageResponse("Mail closed.", true);
  }
  if (customId.startsWith("mail_generate:")) {
    const appId = customId.split(":")[1];
    return messageResponse(`Use \`/gen appid:${appId}\` to generate this manifest.`, true);
  }
  if (customId.startsWith("mail_fix:")) {
    const appId = customId.split(":")[1];
    return messageResponse(`Use \`/fix appid:${appId}\` to request a repair.`, true);
  }

  const jobId = customId.split(":")[1];
  const job = await findJob(env, jobId);
  if (!job) return messageResponse("Request was not found.", true);
  if (job.status === "COMPLETED" || job.uploaded) {
    return messageResponse("", true, { embeds: [alreadyCompletedEmbed(job.type === "fix")] });
  }
  if (customId.startsWith("manifest_upload_chat:")) {
    return startChatUploadFlow(env, interaction, ctx, job);
  }
  return uploadModal(job);
}

export async function handleManifestJobModal(env, interaction, ctx) {
  const jobId = (interaction.data.custom_id || "").split(":")[1];
  const url = interaction.data.components?.[0]?.components?.[0]?.value || "";
  ctx.waitUntil(processUpload(env, interaction, jobId, url));
  return deferredResponse(true);
}

async function processUpload(env, interaction, jobId, url) {
  const user = interactionUser(interaction);
  const started = await startJobUpload(env, interaction, jobId, user.id, (embeds) =>
    editOriginalInteraction(env, interaction, "", null, { embeds })
  );
  if (!started.ok) return;

  let job = started.job;
  const repair = job.type === "fix";
  const fileName = fileNameFromUrl(url);

  if (!isAllowedFile(job.appId, fileName)) {
    job = await resetJobUpload(env, job.id);
    await editOriginalInteraction(env, interaction, "", null, {
      embeds: [uploadRejectedEmbed(job.appId, repair)]
    });
    return;
  }

  try {
    const bytes = await downloadUpload(url);
    await completeUploadFromBytes(env, interaction, job, fileName, bytes, user, {
      publishMode: repair ? "fix" : "new",
      success: {
        title: repair ? "🎉 Repair uploaded successfully" : "🎉 Upload Successful",
        description: "Your file has been published."
      },
      respond: (embeds) => editOriginalInteraction(env, interaction, "", null, { embeds })
    });
  } catch (error) {
    await failUpload(env, interaction, job, repair, fileName, user.id, error, (embeds) =>
      editOriginalInteraction(env, interaction, "", null, { embeds })
    );
  }
}

async function startJobUpload(env, interaction, jobId, userId, respond) {
  const started = await storageCall(env, "manifestJobStartUpload", { jobId, userId });
  if (!started.ok) {
    await respond([started.reason === "COMPLETED" ? alreadyCompletedEmbed(started.job?.type === "fix") : {
      color: ORANGE,
      title: "⚠ Upload Busy",
      description: "Another upload is already being processed for this request.",
      timestamp: new Date().toISOString()
    }]);
    await addHistory(env, {
      appId: started.job?.appId || "unknown",
      jobId,
      type: started.job?.type || "unknown",
      action: "Upload busy",
      userId,
      status: started.reason || "BUSY"
    });
    return { ok: false };
  }
  return started;
}

async function resetJobUpload(env, jobId) {
  return updateJob(env, jobId, (current) => ({ ...current, status: "PENDING", uploadStartedBy: null, uploadStartedAt: null }));
}

async function completeUploadFromBytes(env, interaction, job, fileName, bytes, user, options = {}) {
  const repair = job.type === "fix";
  const publishMode = options.publishMode || (repair ? "fix" : "new");
  const publish = publishMode === "replace"
    ? await publishReplacingManifest(env, job.appId, fileName, bytes, user.id, "Chat upload")
    : repair
      ? await publishFixManifest(env, job.appId, fileName, bytes, user.id)
      : await publishNewManifest(env, job.appId, fileName, bytes, user.id);

  const game = await fetchGameDetails(job.appId);
  const updated = await updateJob(env, job.id, (current) => ({
    ...current,
    status: "COMPLETED",
    uploaded: true,
    uploadedBy: user.id,
    uploadedAt: utcNow(),
    fileName,
    publishedPaths: publish.paths
  }));
  await addHistory(env, {
    appId: updated.appId,
    jobId: updated.id,
    type: updated.type,
    action: options.historyAction || (repair ? "Repair uploaded" : "Manifest uploaded"),
    userId: user.id,
    fileName,
    status: "COMPLETED",
    method: options.method || "direct-url"
  });
  await editRequestMessage(env, updated, [completedEmbed(updated, game)], uploadButton(updated, true, true));
  await options.respond([{
    color: GREEN,
    title: options.success?.title || (repair ? "🎉 Repair uploaded successfully" : "🎉 Upload Successful"),
    description: options.success?.description || "Your file has been published.",
    timestamp: new Date().toISOString()
  }]);
  await sendChannelMessage(env, await gamesAddedChannel(env), "", {
    embeds: [announcementEmbed(updated, game)]
  });
  return updated;
}

async function failUpload(env, interaction, job, repair, fileName, userId, error, respond) {
  const updated = await updateJob(env, job.id, (current) => ({
    ...current,
    status: "FAILED",
    uploaded: false,
    failure: error.message || "Publish failed"
  }));
  await addHistory(env, {
    appId: updated.appId,
    jobId: updated.id,
    type: updated.type,
    action: repair ? "Repair failed" : "Upload failed",
    userId,
    fileName,
    status: "FAILED",
    reason: error.message || "Publish failed"
  });
  await respond([publishFailedEmbed()]);
}

async function startChatUploadFlow(env, interaction, ctx, job) {
  const user = interactionUser(interaction);
  const now = Date.now();
  const session = {
    id: `${job.id}:${user.id}:${now}`,
    userId: user.id,
    channelId: interaction.channel_id,
    jobId: job.id,
    appId: job.appId,
    startedAt: now,
    expiresAt: now + CHAT_UPLOAD_WINDOW_MS
  };
  const started = await startChatUploadSession(env, session);
  if (!started.ok) {
    return messageResponse("You already have an active upload session. Finish it or wait for it to expire.", true);
  }
  await addHistory(env, {
    appId: job.appId,
    jobId: job.id,
    type: job.type,
    action: "Chat upload session started",
    userId: user.id,
    channelId: interaction.channel_id,
    status: "WAITING"
  });
  ctx.waitUntil(watchChatUploadSession(env, interaction, session));
  return messageResponse(
    `**📤 You have 60 seconds to upload the file for App ID ${job.appId} in this channel. Drop it now!**`,
    true,
    { rawContent: true }
  );
}

async function watchChatUploadSession(env, interaction, session) {
  const seen = new Set();
  const maxBytes = chatUploadMaxBytes(env);
  try {
    while (Date.now() < session.expiresAt) {
      const messages = await discordApi(env, `/channels/${session.channelId}/messages?limit=10`).catch(() => []);
      const ordered = Array.isArray(messages)
        ? messages.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        : [];

      for (const message of ordered) {
        if (seen.has(message.id)) continue;
        if (new Date(message.timestamp).getTime() < session.startedAt) continue;
        seen.add(message.id);
        if (message.author?.id !== session.userId) continue;
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        if (!attachments.length) continue;

        const accepted = attachments.find((attachment) =>
          normalizeAllowedUploadFileName(session.appId, attachment.filename, { caseInsensitive: true })
        );
        if (!accepted) {
          await sendInteractionFollowup(env, interaction, [
            "❌ Invalid filename.",
            "Accepted formats:",
            `• ${session.appId}.zip`,
            `• ${session.appId}.lua`
          ].join("\n"), { rawContent: true }).catch(() => null);
          await addHistory(env, {
            appId: session.appId,
            jobId: session.jobId,
            type: "chat-upload",
            action: "Chat upload rejected",
            userId: session.userId,
            channelId: session.channelId,
            status: "REJECTED",
            reason: "Invalid filename"
          });
          continue;
        }

        const normalizedFileName = normalizeAllowedUploadFileName(session.appId, accepted.filename, { caseInsensitive: true });
        if (Number(accepted.size || 0) > maxBytes) {
          await sendInteractionFollowup(env, interaction, uploadSizeError(maxBytes), { rawContent: true }).catch(() => null);
          await addHistory(env, {
            appId: session.appId,
            jobId: session.jobId,
            type: "chat-upload",
            action: "Chat upload rejected",
            userId: session.userId,
            channelId: session.channelId,
            fileName: normalizedFileName,
            status: "REJECTED",
            reason: "File too large"
          });
          continue;
        }

        const user = interactionUser(interaction);
        const started = await startJobUpload(env, interaction, session.jobId, session.userId, (embeds) =>
          sendInteractionFollowup(env, interaction, "", { embeds }).catch(() => null)
        );
        if (!started.ok) {
          await endChatUploadSession(env, session.id, session.userId);
          return;
        }

        try {
          const bytes = await downloadChatAttachment(accepted, maxBytes);
          await completeUploadFromBytes(env, interaction, started.job, normalizedFileName, bytes, user, {
            publishMode: "replace",
            method: "chat-upload",
            historyAction: started.job.type === "fix" ? "Repair uploaded via chat" : "Manifest uploaded via chat",
            success: {
              title: "✅ Upload complete.",
              description: [
                `App ID: \`${session.appId}\``,
                `File: \`${normalizedFileName}\``,
                "",
                "Updated:",
                "• Database 1",
                "• Database 2"
              ].join("\n")
            },
            respond: (embeds) => sendInteractionFollowup(env, interaction, "", { embeds }).catch(() => null)
          });
          await endChatUploadSession(env, session.id, session.userId);
          return;
        } catch (error) {
          if (/File is too large/i.test(error.message || "")) {
            await resetJobUpload(env, started.job.id);
            await sendInteractionFollowup(env, interaction, uploadSizeError(maxBytes), { rawContent: true }).catch(() => null);
            await addHistory(env, {
              appId: session.appId,
              jobId: session.jobId,
              type: "chat-upload",
              action: "Chat upload rejected",
              userId: session.userId,
              channelId: session.channelId,
              fileName: normalizedFileName,
              status: "REJECTED",
              reason: "File too large"
            });
            continue;
          }
          await failUpload(env, interaction, started.job, started.job.type === "fix", normalizedFileName, session.userId, error, (embeds) =>
            sendInteractionFollowup(env, interaction, "", { embeds }).catch(() => null)
          );
          await endChatUploadSession(env, session.id, session.userId);
          return;
        }
      }
      await sleep(CHAT_UPLOAD_POLL_MS);
    }

    await addHistory(env, {
      appId: session.appId,
      jobId: session.jobId,
      type: "chat-upload",
      action: "Chat upload expired",
      userId: session.userId,
      channelId: session.channelId,
      status: "TIMEOUT",
      reason: "No valid attachment in 60 seconds"
    });
    await sendInteractionFollowup(env, interaction, "⌛ Upload window expired.\nRun the command again to upload.", {
      rawContent: true
    }).catch(() => null);
  } finally {
    await endChatUploadSession(env, session.id, session.userId);
  }
}

export async function handleManifestStatusCommand(env, interaction) {
  const appId = normalizeAppId(interaction.data.options?.find((option) => option.name === "appid")?.value);
  const [job, game] = await Promise.all([
    latestJobForApp(env, appId),
    fetchGameDetails(appId)
  ]);
  if (!job) {
    return {
      embeds: [{
        color: DARK,
        title: "No Status Found",
        description: `No request or fix was found for App ID \`${appId}\`.`,
        timestamp: new Date().toISOString()
      }]
    };
  }
  return {
    embeds: [gameThumb({
      color: job.status === "COMPLETED" ? GREEN : job.status === "FAILED" ? RED : ORANGE,
      title: "🟢 Status Found",
      fields: [
        field("🎮 Game", game.name || `Steam App ${appId}`, true),
        field("🆔 App ID", `\`${appId}\``, true),
        field("📌 Type", job.type === "fix" ? "Fix" : "Request", true),
        field("📍 Status", job.status, true),
        field("⬆ Uploaded By", job.uploadedBy ? userMention(job.uploadedBy) : "Waiting", true),
        field("🕒 Updated", timestamp(job.updatedAt || job.createdAt), true)
      ],
      footer: { text: "Charon Status" },
      timestamp: new Date().toISOString()
    }, game)]
  };
}

export async function handleManifestHistoryCommand(env, interaction) {
  const appId = normalizeAppId(interaction.data.options?.find((option) => option.name === "appid")?.value);
  const [items, game] = await Promise.all([
    history(env),
    fetchGameDetails(appId)
  ]);
  const relevant = items.filter((item) => item.appId === appId).slice(0, 10);
  return {
    embeds: [gameThumb({
      color: BLURPLE,
      title: "📜 History",
      fields: [
        field("🎮 Game", game.name || `Steam App ${appId}`, false),
        field("Events", relevant.length
          ? relevant.map((item) => `• **${item.action}** by ${userMention(item.userId)} ${timestamp(item.time)}${item.fileName ? `\n  \`${item.fileName}\`` : ""}`).join("\n")
          : "No history found.", false),
        field("Last Updated", relevant[0] ? timestamp(relevant[0].time) : "Never", true)
      ],
      footer: { text: "Charon History" },
      timestamp: new Date().toISOString()
    }, game)]
  };
}

export async function handleClaimCommand(env, interaction, release = false) {
  await requireBotAdmin(env, interaction);
  const id = interaction.data.options?.find((option) => option.name === "id")?.value;
  const user = interactionUser(interaction);
  const job = await updateJob(env, id, (current) => {
    if (current.status === "COMPLETED") throw new Error("Completed jobs cannot be claimed.");
    return {
      ...current,
      claimedBy: release ? null : user.id,
      claimedAt: release ? null : utcNow(),
      status: release ? "PENDING" : "CLAIMED"
    };
  });
  await addHistory(env, {
    appId: job.appId,
    jobId: job.id,
    type: job.type,
    action: release ? "Claim removed" : "Claimed",
    userId: user.id,
    status: job.status
  });
  return {
    embeds: [{
      color: release ? GREEN : ORANGE,
      title: release ? "🔓 Claim Removed" : "🟡 Request Claimed",
      description: release ? "Request is available again." : `Claimed By:\n${userMention(user.id)}`,
      timestamp: new Date().toISOString()
    }]
  };
}

export async function handleQueueCommand(env, interaction) {
  await requireBotAdmin(env, interaction);
  const current = await jobs(env);
  const pending = current.filter((job) => ["PENDING", "CLAIMED", "UPLOADING"].includes(job.status));
  const oldest = pending.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  return {
    embeds: [{
      color: BLURPLE,
      title: "📋 Queue",
      fields: [
        field("Pending Requests", String(pending.filter((job) => job.type === "request").length), true),
        field("Pending Fixes", String(pending.filter((job) => job.type === "fix").length), true),
        field("Claimed", String(pending.filter((job) => job.claimedBy).length), true),
        field("Oldest", oldest ? timestamp(oldest.createdAt) : "None", true),
        field("Waiting Uploads", pending.slice(0, 8).map((job) => `#${job.id} • ${job.type} • \`${job.appId}\` • ${job.status}`).join("\n") || "None", false)
      ],
      timestamp: new Date().toISOString()
    }]
  };
}

export async function handleCancelCommand(env, interaction) {
  const appId = normalizeAppId(interaction.data.options?.find((option) => option.name === "appid")?.value);
  const user = interactionUser(interaction);
  const admin = await isStoredModerator(env, user.id);
  const job = await latestJobForApp(env, appId);
  if (!job || job.status === "COMPLETED") throw new Error("No cancellable request was found.");
  if (job.requesterId !== user.id && !admin) throw new Error("You cannot cancel this request.");
  const updated = await updateJob(env, job.id, (current) => ({ ...current, status: "CANCELLED", cancelledBy: user.id, cancelledAt: utcNow() }));
  await addHistory(env, {
    appId,
    jobId: updated.id,
    type: updated.type,
    action: "Cancelled",
    userId: user.id,
    status: "CANCELLED"
  });
  await editRequestMessage(env, updated, [{
    color: RED,
    title: "❌ Cancelled",
    description: "Request closed successfully.",
    fields: [field("App ID", `\`${appId}\``, true), field("Cancelled By", userMention(user.id), true)],
    timestamp: new Date().toISOString()
  }], uploadButton(updated, true));
  return {
    embeds: [{
      color: RED,
      title: "❌ Cancelled",
      description: "Request closed successfully.",
      timestamp: new Date().toISOString()
    }]
  };
}

export async function handleStatsCommand(env) {
  const [currentJobs, currentHistory, databaseCounts] = await Promise.all([
    jobs(env),
    history(env),
    countDatabaseFiles(env).catch(() => ({ "database-1": 0, "database-2": 0 }))
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return {
    embeds: [{
      color: BLURPLE,
      title: "📊 Charon Stats",
      fields: [
        field("Games", String(Math.max(databaseCounts["database-1"] || 0, databaseCounts["database-2"] || 0)), true),
        field("Requests", String(currentJobs.filter((job) => job.type === "request").length), true),
        field("Fixes", String(currentJobs.filter((job) => job.type === "fix").length), true),
        field("Uploads", String(currentJobs.filter((job) => job.uploaded).length), true),
        field("Database 1", String(databaseCounts["database-1"] || 0), true),
        field("Database 2", String(databaseCounts["database-2"] || 0), true),
        field("Published Today", String(currentHistory.filter((item) => item.status === "COMPLETED" && String(item.time).startsWith(today)).length), true)
      ],
      footer: { text: "Charon Statistics" },
      timestamp: new Date().toISOString()
    }]
  };
}

export function createMailEmbed({ subject, message, sender }) {
  return {
    color: BLURPLE,
    title: "📬 New Mail",
    description: truncate(message, 4000),
    fields: [
      field("━━━━━━━━━━━━━━━━━━\n📨 Subject", truncate(subject, 1000), false),
      field("━━━━━━━━━━━━━━━━━━\n📝 Message", truncate(message, 1000), false),
      field("━━━━━━━━━━━━━━━━━━\n👤 Sent By", sender, true),
      field("━━━━━━━━━━━━━━━━━━\n🕒 Sent At", absoluteTimestamp(), true)
    ],
    footer: { text: "Powered by Charon Mail System" },
    timestamp: new Date().toISOString()
  };
}

export function mailComponents(options = {}) {
  const row = [];
  if (options.website) {
    row.push({ type: COMPONENT.BUTTON, style: 5, label: "Website", emoji: { name: "🌐" }, url: "https://charon.vyro.workers.dev/" });
  }
  if (options.generate && options.appId) {
    row.push(button(`mail_generate:${options.appId}`, "Generate", BUTTON.PRIMARY, "📦"));
  }
  if (options.fix && options.appId) {
    row.push(button(`mail_fix:${options.appId}`, "Fix", BUTTON.SECONDARY, "🛠"));
  }
  if (options.close) {
    row.push(button("mail_close", "Close", BUTTON.DANGER, "❌"));
  }
  return row.length ? [actionRow(row.slice(0, 5))] : [];
}
