import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS } from "../src/commands.js";

test("COMMANDS is a non-empty array", () => {
  assert.ok(Array.isArray(COMMANDS));
  assert.ok(COMMANDS.length > 0);
});

test("every command has name, description, and default_member_permissions", () => {
  for (const cmd of COMMANDS) {
    assert.ok(typeof cmd.name === "string" && cmd.name.length > 0, `Command missing name: ${JSON.stringify(cmd)}`);
    assert.ok(typeof cmd.description === "string" && cmd.description.length > 0);
    assert.equal(cmd.default_member_permissions, null); // all open by default
  }
});

test("stays within Discord global command limit (100)", () => {
  assert.ok(COMMANDS.length <= 100, `Has ${COMMANDS.length} commands, limit is 100`);
});

test("no duplicate command names", () => {
  const names = COMMANDS.map((c) => c.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length);
});

test("essential commands exist", () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  const required = ["gen", "request", "fix", "onlinefix", "help", "admin", "stats", "website"];
  for (const name of required) {
    assert.ok(names.has(name), `Missing required command: /${name}`);
  }
});

test("gen command has appid option with autocomplete", () => {
  const gen = COMMANDS.find((c) => c.name === "gen");
  assert.ok(gen);
  const appid = gen.options.find((o) => o.name === "appid");
  assert.ok(appid);
  assert.equal(appid.autocomplete, true);
  assert.equal(appid.required, true);
});

test("onlinefix command has game option with autocomplete", () => {
  const cmd = COMMANDS.find((c) => c.name === "onlinefix");
  assert.ok(cmd);
  const game = cmd.options.find((o) => o.name === "game");
  assert.ok(game);
  assert.equal(game.autocomplete, true);
  assert.equal(game.required, true);
  assert.equal(game.type, 3); // STRING
});

test("request and fix commands have appid options without autocomplete", () => {
  for (const name of ["request", "fix"]) {
    const cmd = COMMANDS.find((c) => c.name === name);
    assert.ok(cmd, `Missing command: /${name}`);
    const appid = cmd.options.find((o) => o.name === "appid");
    assert.ok(appid);
    assert.equal(appid.autocomplete, undefined);
    assert.equal(appid.type, 4); // INTEGER
  }
});

test("admin command has subcommands", () => {
  const admin = COMMANDS.find((c) => c.name === "admin");
  assert.ok(admin);
  const subs = admin.options.filter((o) => o.type === 1); // SUB_COMMAND
  assert.ok(subs.length >= 5);
  const subNames = subs.map((s) => s.name);
  assert.ok(subNames.includes("role"));
  assert.ok(subNames.includes("add"));
  assert.ok(subNames.includes("remove"));
  assert.ok(subNames.includes("list"));
  assert.ok(subNames.includes("logs"));
});

test("onlinefix description mentions repair archive", () => {
  const cmd = COMMANDS.find((c) => c.name === "onlinefix");
  assert.ok(cmd.description.toLowerCase().includes("repair") || cmd.description.toLowerCase().includes("archive"));
});
