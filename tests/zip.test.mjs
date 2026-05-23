import assert from "node:assert/strict";
import test from "node:test";
import { buildGameGenGenerateUrl, isZipBytes, lookupPackage } from "../src/github.js";
import { createLuaZip, crc32 } from "../src/zip.js";

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
