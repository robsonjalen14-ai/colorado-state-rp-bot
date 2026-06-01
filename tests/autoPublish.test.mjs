import assert from "node:assert/strict";
import test from "node:test";
import { autoPublishExternalManifest, autoPublishExternalPackage } from "../src/autoPublish.js";

test("autoPublishExternalPackage uploads external ZIP to both databases and announces Charon Bot", async () => {
  const originalFetch = globalThis.fetch;
  const puts = [];
  const announcements = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "GET" && value.includes("/repos/BlissBlender/Charon-Database/contents/database-")) {
      return new Response("not found", { status: 404 });
    }
    if (method === "PUT" && value.includes("/repos/BlissBlender/Charon-Database/contents/database-")) {
      puts.push({ url: value, body: JSON.parse(options.body) });
      return Response.json({ content: { path: value.split("/contents/")[1] } });
    }
    if (method === "POST" && value.endsWith("/channels/1508749560669933648/messages")) {
      announcements.push(JSON.parse(options.body));
      return Response.json({ id: "message-1" });
    }

    throw new Error(`Unexpected fetch: ${method} ${value}`);
  };

  try {
    const result = await autoPublishExternalPackage({
      GITHUB_TOKEN: "token",
      DISCORD_TOKEN: "discord-token"
    }, "2215200", {
      source: "Used External API",
      kind: "api",
      fileName: "2215200.zip",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    }, {
      appId: "2215200",
      name: "LEGO Batman",
      publishers: ["Warner Bros. Games"],
      developers: ["TT Games"],
      genres: ["Action"],
      releaseDate: "May 22, 2026",
      banner: "https://cdn.example/banner.jpg"
    });

    assert.equal(result.published, true);
    assert.equal(puts.length, 2);
    assert.ok(puts.some((put) => put.url.endsWith("/database-1/2215200.zip")));
    assert.ok(puts.some((put) => put.url.endsWith("/database-2/2215200.zip")));
    assert.equal(announcements.length, 1);
    assert.match(JSON.stringify(announcements[0]), /Charon Bot/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("autoPublishExternalPackage ignores non-external results", async () => {
  const result = await autoPublishExternalPackage({}, "480", {
    source: "Used Charon Repo",
    kind: "zip",
    fileName: "480.zip",
    bytes: new Uint8Array([1, 2, 3])
  });

  assert.equal(result.published, false);
  assert.equal(result.reason, "not-external-package");
});

test("autoPublishExternalManifest copies fallback manifest into ManifestVault", async () => {
  const originalFetch = globalThis.fetch;
  const puts = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "GET" && value === "https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main/228980_111.manifest") {
      return new Response(new TextEncoder().encode("manifest"), { status: 200 });
    }
    if (method === "GET" && value === "https://api.github.com/repos/BlissBlender/ManifestVault/contents/228980_111.manifest?ref=main") {
      return new Response("not found", { status: 404 });
    }
    if (method === "PUT" && value === "https://api.github.com/repos/BlissBlender/ManifestVault/contents/228980_111.manifest") {
      puts.push(JSON.parse(options.body));
      return Response.json({ content: { path: "228980_111.manifest" } });
    }

    throw new Error(`Unexpected fetch: ${method} ${value}`);
  };

  try {
    const result = await autoPublishExternalManifest({ GITHUB_TOKEN: "token" }, "228980_111.manifest");

    assert.equal(result.published, true);
    assert.equal(result.result.uploaded, true);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].message, "Backfill 228980_111.manifest from External Vault");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
