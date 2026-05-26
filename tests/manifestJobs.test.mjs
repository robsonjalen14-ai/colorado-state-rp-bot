import assert from "node:assert/strict";
import test from "node:test";
import { parseSteamSuggestHtml } from "../src/github.js";
import { normalizeAllowedUploadFileName } from "../src/manifestJobs.js";
import { databaseUploadPaths } from "../src/publisher.js";

test("parseSteamSuggestHtml extracts game names and app IDs", () => {
  const html = `
    <a href="https://store.steampowered.com/app/4000/Garrys_Mod/">
      <div class="match_name">Garry&apos;s Mod</div>
    </a>
    <a href="/app/730/CounterStrike_2/">
      <div class="match_name">Counter-Strike 2</div>
    </a>
  `;
  const choices = parseSteamSuggestHtml(html);

  assert.deepEqual(choices, [
    { name: "Garry's Mod (4000)", value: "4000" },
    { name: "Counter-Strike 2 (730)", value: "730" }
  ]);
});

test("databaseUploadPaths targets both Charon database folders", () => {
  assert.deepEqual(
    databaseUploadPaths({ DATABASE_BASE_PATHS: ",manifests" }, "123.lua"),
    ["database-1/123.lua", "database-2/123.lua"]
  );
});

test("chat upload filenames are exact by App ID but case-insensitive", () => {
  assert.equal(normalizeAllowedUploadFileName("10", "10.zip", { caseInsensitive: true }), "10.zip");
  assert.equal(normalizeAllowedUploadFileName("10", "10.LUA", { caseInsensitive: true }), "10.lua");
  assert.equal(normalizeAllowedUploadFileName("10", " 10.zip", { caseInsensitive: true }), null);
  assert.equal(normalizeAllowedUploadFileName("10", "11.zip", { caseInsensitive: true }), null);
  assert.equal(normalizeAllowedUploadFileName("10", "10.rar", { caseInsensitive: true }), null);
});
