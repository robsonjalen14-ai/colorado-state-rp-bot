import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS } from "../src/commands.js";
import {
  createManifestEmbed,
  createNoResultsEmbed,
  createWebsiteEmbed,
  websiteButton
} from "../src/embeds.js";

test("createManifestEmbed returns one premium result card with image and badges", () => {
  const embed = createManifestEmbed({
    game: {
      appId: "3542380",
      name: "Example Game",
      publishers: ["Example Publisher"],
      releaseDate: "May 19, 2026",
      banner: "https://cdn.cloudflare.steamstatic.com/steam/apps/3542380/header.jpg"
    },
    source: "Used External API",
    manifestSource: "Manifest Vault",
    elapsedMs: 1234,
    accentColor: 0x123456
  });

  assert.equal(embed.title, "📦 Manifest Package Ready");
  assert.equal(embed.color, 0x123456);
  assert.equal(embed.image.url.includes("3542380"), true);
  assert.match(embed.description, /Example Game/);
  assert.match(embed.description, /App ID: 3542380/);
  assert.match(embed.description, /External API/);
  assert.match(embed.description, /Manifest Vault/);
  // No fields in new layout - all content is in description
});

test("createNoResultsEmbed provides a calm request flow without fake download data", () => {
  const embed = createNoResultsEmbed("2215200");

  assert.equal(embed.title, "🔍 Nothing Available Yet");
  assert.match(embed.description, /No downloadable package/);
  assert.match(embed.description, /\/request appid:2215200/);
  assert.equal(embed.url, undefined);
  assert.equal(embed.image, undefined);
});

test("createWebsiteEmbed and website button point at the public website", () => {
  const embed = createWebsiteEmbed();
  const components = websiteButton();

  assert.equal(embed.url, "https://colorado-state-rp.vyro.workers.dev/");
  assert.equal(embed.title, "🌐 COLORADO STATE RP WEBSITE");
  assert.match(embed.description, /Everything Colorado State RP in one place/i);
  assert.equal(embed.thumbnail.url, "https://colorado-state-rp.vyro.workers.dev/images/icon-512.png");
  assert.equal(components[0].components[0].label, "🌐 Visit Website");
  assert.equal(components[0].components[0].url, "https://colorado-state-rp.vyro.workers.dev/");
});

test("command registry includes website exactly once", () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(names.filter((name) => name === "website").length, 1);
});

test("command registry uses admin only and does not expose staff management", () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(names.includes("admin"), true);
  assert.equal(names.includes("staff"), false);
});

test("command registry stays within Discord global command limit", () => {
  const names = COMMANDS.map((command) => command.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  assert.equal(duplicates.length, 0);
  assert.equal(COMMANDS.length <= 100, true);
  for (const required of ["setticket", "ticket", "ping", "publish", "feedback", "appeal", "fix", "onlinefix", "queue", "stats", "channel"]) {
    assert.equal(names.includes(required), true);
  }
});

test("channel command exposes runtime channel settings", () => {
  const command = COMMANDS.find((item) => item.name === "channel");
  assert.equal(Boolean(command), true);
  const subcommands = command.options.map((item) => item.name);
  assert.deepEqual(subcommands, ["set", "list"]);
  const setCommand = command.options.find((item) => item.name === "set");
  const target = setCommand.options.find((item) => item.name === "target");
  assert.deepEqual(target.choices.map((choice) => choice.value), ["request", "log", "gen", "games", "ticketlog", "genlog"]);
});

test("commands are registered open by default so runtime code controls permissions", () => {
  for (const command of COMMANDS) {
    assert.equal(command.default_member_permissions, null, command.name);
  }
});

test("gen appid option supports Steam name autocomplete while keeping numeric values", () => {
  const gen = COMMANDS.find((command) => command.name === "gen");
  const appid = gen.options.find((option) => option.name === "appid");

  assert.equal(appid.type, 3);
  assert.equal(appid.autocomplete, true);
});
