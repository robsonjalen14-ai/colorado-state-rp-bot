import { publishManifestVaultFile } from "./publisher.js";
import { fetchWithTimeout, storageCall, utcNow } from "./utils.js";

const QUEUE_KEY = "backfillRetryQueue";
const MISSING_KEY = "missingManifestLogs";
const MAX_QUEUE = 300;
const MAX_LOGS = 500;
const MAX_ATTEMPTS = 5;

async function getStored(env, key, fallback) {
  try {
    const data = await storageCall(env, "get", { key, fallback });
    return data.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function putStored(env, key, value) {
  await storageCall(env, "put", { key, value });
}

function nextRetry(attempts) {
  const minutes = Math.min(120, 5 * (2 ** Math.max(0, attempts - 1)));
  return Date.now() + minutes * 60 * 1000;
}

export async function enqueueManifestBackfill(env, job) {
  if (!env.BOT_STORAGE || !job?.fileName || !job?.url) return { queued: false, reason: "missing-storage-or-job" };
  const queue = await getStored(env, QUEUE_KEY, []);
  const existing = queue.find((item) => item.type === "manifest-vault" && item.fileName === job.fileName);
  if (existing) {
    existing.url = job.url;
    existing.updatedAt = utcNow();
    existing.nextRunAt = Math.min(existing.nextRunAt || Date.now(), Date.now() + 60_000);
  } else {
    queue.unshift({
      type: "manifest-vault",
      fileName: job.fileName,
      url: job.url,
      source: job.source || "External Vault",
      attempts: 0,
      createdAt: utcNow(),
      updatedAt: utcNow(),
      nextRunAt: Date.now() + 60_000
    });
  }
  await putStored(env, QUEUE_KEY, queue.slice(0, MAX_QUEUE));
  return { queued: true };
}

export async function recordMissingManifest(env, entry) {
  if (!env.BOT_STORAGE || !entry?.fileName) return;
  const logs = await getStored(env, MISSING_KEY, []);
  logs.unshift({
    fileName: entry.fileName,
    appId: entry.appId || "",
    sources: entry.sources || [],
    time: utcNow()
  });
  await putStored(env, MISSING_KEY, logs.slice(0, MAX_LOGS));
}

async function downloadBytes(url) {
  const response = await fetchWithTimeout(url, {
    timeout: 30000,
    headers: { Accept: "application/octet-stream" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function processBackfillRetryQueue(env, limit = 10) {
  if (!env.BOT_STORAGE) return { ok: false, processed: 0, reason: "missing-storage" };
  const queue = await getStored(env, QUEUE_KEY, []);
  const now = Date.now();
  const remaining = [];
  let processed = 0;
  const results = [];

  for (const job of queue) {
    if (processed >= limit || Number(job.nextRunAt || 0) > now) {
      remaining.push(job);
      continue;
    }

    processed += 1;
    try {
      if (job.type !== "manifest-vault") throw new Error(`Unsupported retry type: ${job.type}`);
      const bytes = await downloadBytes(job.url);
      const result = await publishManifestVaultFile(env, job.fileName, bytes, job.source || "External Vault");
      results.push({ fileName: job.fileName, ok: true, result });
      if (!result?.uploaded && result?.reason !== "exists") {
        remaining.push({ ...job, attempts: (job.attempts || 0) + 1, nextRunAt: nextRetry((job.attempts || 0) + 1), updatedAt: utcNow() });
      }
    } catch (error) {
      const attempts = (job.attempts || 0) + 1;
      results.push({ fileName: job.fileName, ok: false, error: error.message });
      if (attempts < MAX_ATTEMPTS) {
        remaining.push({ ...job, attempts, nextRunAt: nextRetry(attempts), updatedAt: utcNow(), lastError: error.message });
      }
    }
  }

  await putStored(env, QUEUE_KEY, remaining.slice(0, MAX_QUEUE));
  return { ok: true, processed, remaining: remaining.length, results };
}

export async function backfillQueueStatus(env) {
  const queue = await getStored(env, QUEUE_KEY, []);
  const missing = await getStored(env, MISSING_KEY, []);
  return {
    queuedBackfills: queue.length,
    missingManifestLogs: missing.length,
    nextRetryAt: queue.reduce((next, job) => {
      const value = Number(job.nextRunAt || 0);
      return value && (!next || value < next) ? value : next;
    }, 0)
  };
}
