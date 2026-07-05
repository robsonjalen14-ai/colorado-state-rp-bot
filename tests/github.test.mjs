import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSteamSuggestHtml,
  extractDepotIdsFromLua,
  extractDirectManifestFileNames,
  isZipBytes,
  buildGameGenGenerateUrl,
  formatGameDetails
} from "../src/github.js";

test("parseSteamSuggestHtml extracts game names and app IDs", () => {
  const html = `
    <a href="https://store.steampowered.com/app/1245620/Elden_Ring/" class="match_row">
      <img src="https://example.com/img.jpg" />
      <span class="match_name">Elden Ring</span>
    </a>
    <a href="https://store.steampowered.com/app/730/CounterStrike_2/" class="match_row">
      <span class="match_name">Counter-Strike 2</span>
    </a>
  `;
  const result = parseSteamSuggestHtml(html);
  assert.ok(result.length >= 2);
  assert.ok(result.some(r => r.name.includes("Elden Ring")));
  assert.ok(result.some(r => r.value === "1245620"));
  assert.ok(result.some(r => r.value === "730"));
});

test("parseSteamSuggestHtml deduplicates by app ID", () => {
  const html = `
    <a href="/app/730/" class="match_row"><span class="match_name">CS2</span></a>
    <a href="/app/730/?snr=" class="match_row"><span class="match_name">CS2 Again</span></a>
  `;
  const result = parseSteamSuggestHtml(html);
  assert.equal(result.length, 1);
});

test("parseSteamSuggestHtml returns empty for invalid HTML", () => {
  assert.deepEqual(parseSteamSuggestHtml(""), []);
  assert.deepEqual(parseSteamSuggestHtml("<html>no links</html>"), []);
});

test("extractDepotIdsFromLua extracts depot IDs via addappid pattern", () => {
  // The regex matches: addappid( <id>, <branch>, "<sha>" )
  const lua = `addappid( 12345, 0, "abcdef1234567890" )`;
  const result = extractDepotIdsFromLua(lua);
  assert.ok(result.includes("12345"));
});

test("extractDepotIdsFromLua returns empty for no depots", () => {
  assert.deepEqual(extractDepotIdsFromLua(""), []);
});

test("extractDirectManifestFileNames extracts manifest names", () => {
  // The regex matches: <digits>_<digits>.manifest
  const lua = `12345_67890.manifest`;
  const result = extractDirectManifestFileNames(lua);
  assert.ok(result.length >= 1);
  assert.ok(result.some(r => r.includes("12345_67890.manifest")));
});

test("extractDirectManifestFileNames handles empty", () => {
  assert.deepEqual(extractDirectManifestFileNames(""), []);
});

test("isZipBytes detects ZIP magic bytes", () => {
  assert.ok(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])));
  assert.equal(isZipBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03])), false);
});

test("isZipBytes handles empty and null", () => {
  assert.equal(isZipBytes(new Uint8Array(0)), false);
  assert.equal(isZipBytes(null), false);
});

test("buildGameGenGenerateUrl appends AppID", () => {
  const url = buildGameGenGenerateUrl("https://example.com/generate", "730");
  assert.ok(url.endsWith("/730"));
});

test("formatGameDetails formats game object", () => {
  const game = { name: "Test Game", appId: 12345, publishers: ["Valve"], releaseDate: "2024-01-01" };
  const formatted = formatGameDetails(game);
  assert.ok(formatted.includes("Test Game"));
  assert.ok(formatted.includes("12345"));
  assert.ok(formatted.includes("Valve"));
  assert.ok(formatted.includes("2024-01-01"));
});

test("formatGameDetails handles missing publisher as Unknown", () => {
  const game = { name: "Test", appId: 1, publishers: [], releaseDate: "TBD" };
  const formatted = formatGameDetails(game);
  assert.ok(formatted.includes("Unknown"));
});
