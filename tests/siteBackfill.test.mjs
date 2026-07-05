import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

test("site backfill endpoint publishes external API package through the bot", async () => {
  const originalFetch = globalThis.fetch;
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const puts = [];
  const messages = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.includes("raw.githubusercontent.com/example")) return new Response("", { status: 404 });
    if (method === "GET" && value.includes("gamegen.lol")) return new Response(zip, { status: 200 });
    if (method === "GET" && value.includes("api.github.com/repos/BlissBlender/Colorado-State-RP-Database/contents/database-")) {
      return new Response("not found", { status: 404 });
    }
    if (method === "PUT" && value.includes("api.github.com/repos/BlissBlender/Colorado-State-RP-Database/contents/database-")) {
      puts.push(value);
      return Response.json({ ok: true });
    }
    if (method === "GET" && value.includes("store.steampowered.com")) {
      return Response.json({ 480: { success: false } });
    }
    if (method === "GET" && value.includes("steamspy.com")) {
      return Response.json({ name: "Spacewar", publisher: "Valve", developer: "Valve", genre: "Action", release_date: "Unknown" });
    }
    if (method === "GET" && value.includes("cdn.cloudflare.steamstatic.com")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (method === "POST" && value.endsWith("/channels/1508749560669933648/messages")) {
      messages.push(JSON.parse(options.body));
      return Response.json({ id: "message-1" });
    }

    throw new Error(`Unexpected fetch: ${method} ${value}`);
  };

  try {
    const response = await worker.fetch(new Request("https://colorado-state-rp-bot.test/api/backfill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://colorado-state-rp.vyro.workers.dev"
      },
      body: JSON.stringify({ type: "external-package", appId: "480" })
    }), {
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/",
      GITHUB_TOKEN: "token",
      DISCORD_TOKEN: "discord-token"
    }, { waitUntil: () => null });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.published.published, true);
    assert.equal(puts.length, 2);
    assert.equal(messages.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health endpoint reports GitHub and storage readiness", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";
    if (method === "GET" && value === "https://api.github.com/repos/BlissBlender/Colorado-State-RP-Database") {
      return Response.json({ full_name: "BlissBlender/Colorado-State-RP-Database" });
    }
    if (method === "GET" && value === "https://api.github.com/repos/BlissBlender/ManifestVault") {
      return Response.json({ full_name: "BlissBlender/ManifestVault" });
    }
    throw new Error(`Unexpected fetch: ${method} ${value}`);
  };

  try {
    const response = await worker.fetch(new Request("https://colorado-state-rp-bot.test/health"), {
      GITHUB_TOKEN: "token",
      DISCORD_TOKEN: "discord-token",
      BOT_STORAGE: {
        idFromName: () => "global",
        get: () => ({
          fetch: async (_url, request) => {
            const body = await request.json();
            if (body.op === "get") return Response.json({ value: body.fallback });
            return Response.json({ ok: true });
          }
        })
      }
    }, { waitUntil: () => null });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.health.checks.coloradoStateRpDatabase, true);
    assert.equal(data.health.checks.manifestVault, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
