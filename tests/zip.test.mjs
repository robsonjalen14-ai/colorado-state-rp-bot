import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGameGenGenerateUrl,
  extractDepotIdsFromLua,
  extractDirectManifestFileNames,
  isZipBytes,
  lookupPackage,
  lookupRepositoryPackage
} from "../src/github.js";
import { createFlatZipFromEntries, createLuaManifestZip, createLuaZip, createZip, crc32, readZipEntries } from "../src/zip.js";

test("crc32 matches known value", () => {
  assert.equal(crc32(new TextEncoder().encode("hello")), 0x3610a686);
});

test("createLuaZip creates a valid zip signature", () => {
  const zip = createLuaZip("480", new TextEncoder().encode("print('ok')"));
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const text = new TextDecoder().decode(zip);
  assert.match(text, /480\.lua/);
});

test("createLuaManifestZip stores lua and manifest files at zip root without duplicates", () => {
  const zip = createLuaManifestZip("480", new TextEncoder().encode("print('ok')"), [
    { fileName: "228980_111.manifest", bytes: new TextEncoder().encode("manifest-a") },
    { fileName: "228980_111.manifest", bytes: new TextEncoder().encode("manifest-a-duplicate") },
    { fileName: "228981_222.manifest", bytes: new TextEncoder().encode("manifest-b") }
  ]);
  const text = new TextDecoder().decode(zip);
  assert.match(text, /480\.lua/);
  assert.match(text, /228980_111\.manifest/);
  assert.match(text, /228981_222\.manifest/);
  assert.doesNotMatch(text, /scripts\/480\.lua/);
  assert.doesNotMatch(text, /manifests\/228980_111\.manifest/);
  assert.equal((text.match(/228980_111\.manifest/g) || []).length, 2);
});

test("createFlatZipFromEntries preserves existing manifests and adds only missing files", () => {
  const encoder = new TextEncoder();
  const zip = createFlatZipFromEntries([
    { name: "nested/480.lua", bytes: encoder.encode("lua") },
    { name: "nested/228980_111.manifest", bytes: encoder.encode("existing") }
  ], [
    { fileName: "228980_111.manifest", bytes: encoder.encode("replacement") },
    { fileName: "228981_222.manifest", bytes: encoder.encode("new") }
  ]);
  const entries = readZipEntries(zip);
  const names = entries.map((entry) => entry.name).sort();
  const existing = entries.find((entry) => entry.name === "228980_111.manifest");

  assert.deepEqual(names, ["228980_111.manifest", "228981_222.manifest", "480.lua"]);
  assert.equal(new TextDecoder().decode(existing.bytes), "existing");
});

test("lua parser extracts CharonManifestInstall depot ids and direct manifest names", () => {
  const lua = `
    addappid(228980, 1, "abcdef123456")
    addappid(228980, 1, "abcdef123456")
    addappid(228981, 1, "abcdef123456")
    local file = "228980_111.manifest"
  `;
  assert.deepEqual(extractDepotIdsFromLua(lua), ["228980", "228981"]);
  assert.deepEqual(extractDirectManifestFileNames(lua), ["228980_111.manifest"]);
});

test("buildGameGenGenerateUrl appends AppID when URL ends at generate", () => {
  assert.equal(
    buildGameGenGenerateUrl("https://gamegen.lol/api/key/generate/", "730"),
    "https://gamegen.lol/api/key/generate/730"
  );
  assert.equal(
    buildGameGenGenerateUrl("https://gamegen.lol/api/key/generate/{APP_ID}", "730"),
    "https://gamegen.lol/api/key/generate/730"
  );
});

test("lookupPackage falls back to external API zip when Charon repo misses", async () => {
  const originalFetch = globalThis.fetch;
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const seen = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    seen.push({ url: value, method: options.method || "GET" });
    if (value.includes("gamegen.lol") && value.includes("format=zip")) {
      return new Response(zip, {
        status: 200,
        headers: { "Content-Type": "application/zip" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: ",manifests",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "2215200");

    assert.equal(result.source, "Used External API");
    assert.equal(result.fileName, "2215200.zip");
    assert.equal(isZipBytes(result.bytes), true);
    assert.equal(seen.some((entry) => entry.url.endsWith("/2215200?format=zip")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage bundles required manifests when loose lua is generated", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const seen = [];
  const lua = encoder.encode('addappid(228980, 1, "abcdef123456")');
  const manifestBytes = encoder.encode("manifest-content");

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";
    seen.push({ url: value, method });

    if (method === "HEAD" && value.endsWith("/480.zip")) {
      return new Response("", { status: 404 });
    }
    if (method === "HEAD" && value.endsWith("/480.lua")) {
      return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    }
    if (method === "GET" && value.endsWith("/480.lua")) {
      return new Response(lua, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/BlissBlender/ManifestVault/main/228980_111.manifest") {
      return new Response(manifestBytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");

    const text = new TextDecoder().decode(result.bytes);
    assert.equal(result.kind, "lua");
    assert.equal(result.source, "Used Charon Repo");
    assert.equal(result.manifestSource, "Manifest Vault");
    assert.match(text, /480\.lua/);
    assert.match(text, /228980_111\.manifest/);
    assert.doesNotMatch(text, /scripts\/480\.lua/);
    assert.doesNotMatch(text, /manifests\/228980_111\.manifest/);
    assert.equal(seen.filter((entry) => entry.url.endsWith("/228980_111.manifest")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage enriches direct database zip that contains lua", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const zip = createLuaZip("480", encoder.encode('addappid(228980, 1, "abcdef123456")'));

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.zip")) return new Response(zip, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/BlissBlender/ManifestVault/main/228980_111.manifest") {
      return new Response(encoder.encode("manifest-content"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");
    const names = readZipEntries(result.bytes).map((entry) => entry.name).sort();

    assert.equal(result.kind, "zip");
    assert.equal(result.manifestSource, "Manifest Vault");
    assert.deepEqual(names, ["228980_111.manifest", "480.lua"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage preserves existing manifests in direct database zip and does not refetch them", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const zip = createZip([
    { name: "480.lua", bytes: encoder.encode('addappid(228980, 1, "abcdef123456")') },
    { name: "228980_111.manifest", bytes: encoder.encode("existing-manifest") }
  ]);
  const seen = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";
    seen.push({ url: value, method });

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.zip")) return new Response(zip, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value.endsWith("/228980_111.manifest")) {
      return new Response(encoder.encode("replacement-manifest"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");
    const manifest = readZipEntries(result.bytes).find((entry) => entry.name === "228980_111.manifest");

    assert.equal(result.manifestSource, "");
    assert.equal(new TextDecoder().decode(manifest.bytes), "existing-manifest");
    assert.equal(seen.some((entry) => entry.url.endsWith("/228980_111.manifest")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage enriches indexed database zip that contains lua", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const zip = createLuaZip("480", encoder.encode('addappid(228980, 1, "abcdef123456")'));

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: 404 });
    if (method === "HEAD" && value.endsWith("/480.lua")) return new Response("", { status: 404 });
    if (method === "GET" && value.endsWith("/index.json")) {
      return Response.json({ 480: { zip: "random.zip" } });
    }
    if (method === "HEAD" && value.endsWith("/random.zip")) return new Response("", { status: 200 });
    if (method === "GET" && value.endsWith("/random.zip")) return new Response(zip, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/BlissBlender/ManifestVault/main/228980_111.manifest") {
      return new Response(encoder.encode("manifest-content"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");
    const names = readZipEntries(result.bytes).map((entry) => entry.name).sort();

    assert.equal(result.kind, "indexed-zip");
    assert.equal(result.manifestSource, "Manifest Vault");
    assert.deepEqual(names, ["228980_111.manifest", "480.lua"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage still returns lua-only zip when optional manifests are missing", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const lua = encoder.encode('addappid(228980, 1, "abcdef123456")');

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: 404 });
    if (method === "HEAD" && value.endsWith("/480.lua")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.lua")) return new Response(lua, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");

    const text = new TextDecoder().decode(result.bytes);
    assert.equal(result.kind, "lua");
    assert.equal(result.manifestSource, "");
    assert.match(text, /480\.lua/);
    assert.doesNotMatch(text, /228980_111\.manifest/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage labels fallback manifest source as External Vault", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const lua = encoder.encode('addappid(228980, 1, "abcdef123456")');

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: 404 });
    if (method === "HEAD" && value.endsWith("/480.lua")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.lua")) return new Response(lua, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main/228980_111.manifest") {
      return new Response(encoder.encode("fallback-manifest"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "480");

    assert.equal(result.manifestSource, "External Vault");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage backfills fallback manifests into ManifestVault when requested", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const lua = encoder.encode('addappid(228980, 1, "abcdef123456")');
  const puts = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: 404 });
    if (method === "HEAD" && value.endsWith("/480.lua")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.lua")) return new Response(lua, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: {
          480: {
            depots: {
              228980: {
                manifests: {
                  public: { gid: "111" }
                }
              }
            }
          }
        }
      });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main/228980_111.manifest") {
      return new Response(encoder.encode("fallback-manifest"), { status: 200 });
    }
    if (method === "GET" && value === "https://api.github.com/repos/BlissBlender/ManifestVault/contents/228980_111.manifest?ref=main") {
      return new Response("not found", { status: 404 });
    }
    if (method === "PUT" && value === "https://api.github.com/repos/BlissBlender/ManifestVault/contents/228980_111.manifest") {
      puts.push(JSON.parse(options.body));
      return Response.json({ content: { path: "228980_111.manifest" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/",
      GITHUB_TOKEN: "token"
    }, "480", { awaitBackfills: true });

    assert.equal(result.manifestSource, "External Vault");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].message, "Backfill 228980_111.manifest from External Vault");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage reads ManifestVault through GitHub API to avoid raw cache delay", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const lua = encoder.encode('addappid(228980, 1, "abcdef123456")');
  const manifestContent = btoa("api-manifest");
  const seen = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || "GET";
    seen.push({ value, method });

    if (method === "HEAD" && value.endsWith("/480.zip")) return new Response("", { status: 404 });
    if (method === "HEAD" && value.endsWith("/480.lua")) return new Response("", { status: value.includes("database-1") ? 200 : 404 });
    if (method === "GET" && value.endsWith("/480.lua")) return new Response(lua, { status: 200 });
    if (method === "GET" && value === "https://api.steamcmd.net/v1/info/480") {
      return Response.json({
        status: "success",
        data: { 480: { depots: { 228980: { manifests: { public: { gid: "111" } } } } } }
      });
    }
    if (method === "GET" && value === "https://api.github.com/repos/BlissBlender/ManifestVault/contents/228980_111.manifest?ref=main") {
      return Response.json({ content: manifestContent });
    }
    if (method === "GET" && value === "https://raw.githubusercontent.com/BlissBlender/ManifestVault/main/228980_111.manifest") {
      return new Response("stale raw cache", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: "",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/",
      GITHUB_TOKEN: "token"
    }, "480", { awaitBackfills: true });

    assert.equal(result.manifestSource, "Manifest Vault");
    assert.ok(seen.some((item) => item.value.includes("api.github.com/repos/BlissBlender/ManifestVault")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupRepositoryPackage can check Charon repo without downloading bytes", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];

  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), method: options.method || "GET" });
    if ((options.method || "GET") === "HEAD" && String(url).endsWith("/480.zip")) {
      return new Response("", { status: 200 });
    }
    throw new Error("Unexpected download");
  };

  try {
    const result = await lookupRepositoryPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: ""
    }, "480", { includeBytes: false });

    assert.equal(result.kind, "zip");
    assert.equal(result.bytes, undefined);
    assert.equal(seen.some((entry) => entry.method === "GET"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage returns external download link when Worker is blocked by GameGen", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("gamegen.lol")) {
      return new Response(JSON.stringify({ error: "VPN_BLOCKED", redirect: "/vpn-blocked" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: ",manifests",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "2215200");

    assert.equal(result.source, "Used External API");
    assert.equal(result.kind, "api-link");
    assert.equal(result.fileName, "2215200.zip");
    assert.equal(result.downloadUrl, "https://gamegen.lol/api/key/generate/2215200?format=zip");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupPackage returns null when repo and external API return no package", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("gamegen.lol")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await lookupPackage({
      DATABASE_1_URL: "https://raw.githubusercontent.com/example/database-1/",
      DATABASE_2_URL: "https://raw.githubusercontent.com/example/database-2/",
      DATABASE_BASE_PATHS: ",manifests",
      GAMEGEN_API_URL: "https://gamegen.lol/api/key/generate/"
    }, "999999999");

    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
