import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import worker from "./worker.js";

const STORAGE_FILE = process.env.BOT_STORAGE_FILE || path.resolve(process.cwd(), "data", "bot-storage.json");

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORAGE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(data) {
  await fs.mkdir(path.dirname(STORAGE_FILE), { recursive: true });
  await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2));
}

function localStorageBinding() {
  return {
    idFromName(name) {
      return name;
    },
    get() {
      return {
        async fetch(_url, init = {}) {
          const body = JSON.parse(init.body || "{}");
          const store = await readStore();
          if (body.op === "get") {
            return Response.json({ value: store[body.key] ?? body.fallback ?? null });
          }
          if (body.op === "put") {
            store[body.key] = body.value;
            await writeStore(store);
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            delete store[body.key];
            await writeStore(store);
            return Response.json({ ok: true });
          }
          if (body.op === "manifestJobStartUpload") {
            const jobs = Array.isArray(store.manifestJobs) ? store.manifestJobs : [];
            const index = jobs.findIndex((job) => String(job.id) === String(body.jobId));
            if (index === -1) return Response.json({ ok: false, reason: "NOT_FOUND" });
            const job = jobs[index];
            if (job.status === "COMPLETED" || job.uploaded) return Response.json({ ok: false, reason: "COMPLETED", job });
            if (job.status === "UPLOADING") return Response.json({ ok: false, reason: "UPLOADING", job });
            jobs[index] = { ...job, status: "UPLOADING", uploadStartedBy: body.userId, uploadStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            store.manifestJobs = jobs;
            await writeStore(store);
            return Response.json({ ok: true, job: jobs[index] });
          }
          if (body.op === "manifestChatUploadSessionStart") {
            const sessions = store.manifestChatUploadSessions || {};
            const now = Date.now();
            for (const [userId, session] of Object.entries(sessions)) {
              if (!session?.expiresAt || Number(session.expiresAt) <= now) delete sessions[userId];
            }
            const existing = sessions[body.session?.userId];
            if (existing && Number(existing.expiresAt) > now) {
              store.manifestChatUploadSessions = sessions;
              await writeStore(store);
              return Response.json({ ok: false, reason: "ACTIVE", session: existing });
            }
            sessions[body.session.userId] = body.session;
            store.manifestChatUploadSessions = sessions;
            await writeStore(store);
            return Response.json({ ok: true, session: body.session });
          }
          if (body.op === "manifestChatUploadSessionEnd") {
            const sessions = store.manifestChatUploadSessions || {};
            const existing = sessions[body.userId];
            if (!existing || existing.id === body.sessionId) delete sessions[body.userId];
            store.manifestChatUploadSessions = sessions;
            await writeStore(store);
            return Response.json({ ok: true });
          }
          return Response.json({ error: "Unknown storage op." }, { status: 400 });
        }
      };
    }
  };
}

function envFromProcess() {
  return {
    ...process.env,
    BOT_STORAGE: localStorageBinding()
  };
}

function requestFromNode(req, body) {
  const protocol = process.env.PUBLIC_ORIGIN?.startsWith("https://") ? "https" : "http";
  const host = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", process.env.PUBLIC_ORIGIN || `${protocol}://${host}`);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : body
  });
}

async function writeNodeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const request = requestFromNode(req, Buffer.concat(chunks));
      const waitUntilTasks = [];
      const response = await worker.fetch(request, envFromProcess(), {
        waitUntil(task) {
          waitUntilTasks.push(Promise.resolve(task).catch((error) => console.error("[waitUntil]", error)));
        }
      });
      await writeNodeResponse(res, response);
      Promise.allSettled(waitUntilTasks).catch(() => null);
    } catch (error) {
      console.error("[server]", error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Colorado State RP Bot HTTP interaction server listening on ${port}`);
});
