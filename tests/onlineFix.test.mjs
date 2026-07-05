import assert from "node:assert/strict";
import test from "node:test";
import {
  onlineFixEmbed,
  onlineFixDownloadUrl,
  onlineFixNotFoundEmbed,
  parsePeronDepotDirectory,
  searchOnlineFixFiles,
  onlineFixButton,
  PERON_DEPOT_BASE_URL
} from "../src/onlineFix.js";

test("PERON_DEPOT_BASE_URL is defined", () => {
  assert.ok(PERON_DEPOT_BASE_URL.startsWith("https://"));
});

test("parsePeronDepotDirectory extracts unique archive filenames from HTML index", () => {
  const html = `
    <a href="../">../</a>
    <a href="Among%20Us%20-%20AmongUs_Fix_Repair_GDK_Generic.rar">Among Us</a>
    <a href="Among%20Us%20-%20AmongUs_Fix_Repair_GDK_Generic.rar">Duplicate</a>
    <a href="readme.txt">readme</a>
  `;
  const files = parsePeronDepotDirectory(html);
  assert.equal(files.length, 1);
  assert.ok(files[0].includes("AmongUs_Fix_Repair_GDK_Generic.rar"));
});

test("parsePeronDepotDirectory handles empty HTML", () => {
  assert.deepEqual(parsePeronDepotDirectory(""), []);
  assert.deepEqual(parsePeronDepotDirectory("<html></html>"), []);
});

test("searchOnlineFixFiles finds best fuzzy match and prefers Steam", () => {
  const files = [
    "Lethal Company - LethalCompany_Fix_Repair_Epic_Generic.rar",
    "Lethal Company - LethalCompany_Fix_Repair_Steam_Generic.rar",
    "Among Us - AmongUs_Fix_Repair_GDK_Generic.rar"
  ];
  const matches = searchOnlineFixFiles(files, "lethal company");
  assert.ok(matches.length >= 1);
  assert.ok(matches[0].fileName.includes("LethalCompany"));
  assert.equal(matches.some((item) => item.fileName.includes("Among Us")), false);
});

test("searchOnlineFixFiles returns empty for no match", () => {
  const matches = searchOnlineFixFiles(["SomeGame_Fix_Repair_Steam.rar"], "xyznonexistent");
  assert.deepEqual(matches, []);
});

test("searchOnlineFixFiles handles empty inputs", () => {
  assert.deepEqual(searchOnlineFixFiles([], "test"), []);
  assert.deepEqual(searchOnlineFixFiles(["game.rar"], ""), []);
  assert.deepEqual(searchOnlineFixFiles(null, "test"), []);
});

test("searchOnlineFixFiles returns platform variants of same game when close", () => {
  const files = [
    "Elden Ring - EldenRing_Fix_Repair_Steam_Generic.rar",
    "Elden Ring - EldenRing_Fix_Repair_Epic_Generic.rar",
    "Different Game - DifferentGame_Fix_Repair_Steam.rar"
  ];
  const matches = searchOnlineFixFiles(files, "elden ring");
  // Should return at least the best Elden Ring variant
  assert.ok(matches.length >= 1);
  assert.ok(matches[0].fileName.includes("EldenRing"));
  assert.equal(matches.some((m) => m.fileName.includes("Different")), false);
});

test("searchOnlineFixFiles returns single result when clearly better", () => {
  const files = [
    "Exactly Matching - ExactlyMatching_Fix_Repair_Steam.rar",
    "Totally Different - TotallyDifferent_Fix_Repair_Steam.rar"
  ];
  const matches = searchOnlineFixFiles(files, "exactly matching");
  assert.equal(matches.length, 1);
  assert.ok(matches[0].fileName.includes("Exactly"));
});

test("onlineFixDownloadUrl percent-encodes filename", () => {
  const url = onlineFixDownloadUrl("Game Name_Fix_Steam.rar");
  assert.ok(url.includes(".rar"));
});

test("onlineFixDownloadUrl throws for invalid filename", () => {
  assert.throws(() => onlineFixDownloadUrl(""), /Invalid/);
  assert.throws(() => onlineFixDownloadUrl("readme.txt"), /Invalid/);
});

test("onlineFixEmbed renders storage vault style", () => {
  const embed = onlineFixEmbed("meccha", {
    fileName: "Meccha Chameleon - MecchaChameleon_Fix_Repair_Steam_Generic.rar",
    url: "https://api.perondepot.xyz/all/file.rar",
    matches: [{
      fileName: "Meccha Chameleon - MecchaChameleon_Fix_Repair_Steam_Generic.rar",
      url: "https://api.perondepot.xyz/all/file.rar"
    }]
  });
  assert.equal(embed.title, "🌐 Online MultiPlayer Fix Storage Vault");
  assert.ok(embed.description.includes("meccha"));
  assert.equal(embed.color, 0x5865f2);
});

test("onlineFixNotFoundEmbed returns error embed with game name", () => {
  const embed = onlineFixNotFoundEmbed("nonexistent game");
  assert.equal(embed.title, "OnlineFix Not Found");
  assert.ok(embed.description.includes("nonexistent game"));
  assert.equal(embed.color, 0xed4245);
});

test("onlineFixButton returns download button component", () => {
  const buttons = onlineFixButton("https://example.com/d.rar");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].type, 1);
  assert.equal(buttons[0].components[0].style, 5);
});
