import assert from "node:assert/strict";
import test from "node:test";
import {
  json,
  text,
  hexToBytes,
  encodePathPart,
  joinUrl,
  normalizeBasePath,
  getConfiguredBasePaths,
  normalizeAppId,
  normalizeUserId,
  getOption,
  getOptionValue,
  getSubcommand,
  truncate,
  utcNow,
  snowflakeToDate,
  permissionBits,
  hasPermission,
  isAdmin,
  isManageServer
} from "../src/utils.js";

test("json creates response with JSON body", async () => {
  const res = json({ ok: true });
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(res.status, 200);
});

test("json accepts custom status code", async () => {
  const res = json({ error: "fail" }, 400);
  assert.equal(res.status, 400);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, "fail");
});

test("text creates plain text response", async () => {
  const res = text("hello", 201);
  assert.equal(res.status, 201);
  const body = await res.text();
  assert.equal(body, "hello");
});

test("hexToBytes converts hex string to Uint8Array", () => {
  const bytes = hexToBytes("aabb");
  assert.equal(bytes.length, 2);
  assert.equal(bytes[0], 0xaa);
  assert.equal(bytes[1], 0xbb);
});

test("hexToBytes throws for empty string", () => {
  assert.throws(() => hexToBytes(""), /Invalid hex/);
  assert.throws(() => hexToBytes("abc"), /Invalid hex/);
});

test("encodePathPart encodes special characters", () => {
  assert.equal(encodePathPart("normal"), "normal");
  assert.ok(encodePathPart("hello world").includes("%20"));
});

test("joinUrl combines base and path correctly", () => {
  assert.equal(joinUrl("https://example.com/", "file.txt"), "https://example.com/file.txt");
  assert.ok(joinUrl("https://example.com", "/file.txt").endsWith("/file.txt"));
  assert.equal(joinUrl("https://example.com/base/", "sub/file.txt"), "https://example.com/base/sub/file.txt");
});

test("normalizeBasePath trims slashes", () => {
  assert.equal(normalizeBasePath("/path/to/dir/"), "path/to/dir");
  assert.equal(normalizeBasePath("plain"), "plain");
});

test("getConfiguredBasePaths uses DATABASE_BASE_PATHS env var", () => {
  const env = { DATABASE_BASE_PATHS: "path1,path2,path3" };
  const paths = getConfiguredBasePaths(env);
  assert.equal(paths.length, 3);
  assert.equal(paths[0], "path1");
});

test("getConfiguredBasePaths defaults to manifests", () => {
  const paths = getConfiguredBasePaths({});
  assert.ok(paths.length >= 1);
  assert.ok(paths.some(p => p.includes("manifests")));
});

test("normalizeAppId throws for non-numeric input", () => {
  assert.throws(() => normalizeAppId(""), /App ID/);
  assert.throws(() => normalizeAppId("abc"), /App ID/);
});

test("normalizeAppId accepts numeric strings including 0", () => {
  assert.equal(normalizeAppId("0"), "0");
  assert.equal(normalizeAppId("12345"), "12345");
  assert.equal(normalizeAppId(12345), "12345");
});

test("normalizeUserId extracts ID from mention", () => {
  const id = normalizeUserId("<@!123456789012345678>");
  assert.equal(id, "123456789012345678");
});

test("normalizeUserId throws for invalid input", () => {
  assert.throws(() => normalizeUserId(""), /user ID/);
  assert.throws(() => normalizeUserId("abc"), /user ID/);
});

test("getOption finds option by name", () => {
  const options = [{ name: "game", value: "test" }, { name: "count", value: 5 }];
  assert.deepEqual(getOption(options, "game"), { name: "game", value: "test" });
  assert.equal(getOption(options, "missing"), undefined);
});

test("getOptionValue returns value or fallback", () => {
  const options = [{ name: "game", value: "elden ring" }];
  assert.equal(getOptionValue(options, "game"), "elden ring");
  assert.equal(getOptionValue(options, "missing", "default"), "default");
});

test("getSubcommand extracts first subcommand", () => {
  const data = { options: [{ type: 1, name: "add" }, { type: 3, name: "game" }] };
  assert.deepEqual(getSubcommand(data), { type: 1, name: "add" });
});

test("getSubcommand returns undefined when no subcommand", () => {
  const data = { options: [{ type: 3, name: "game" }] };
  assert.equal(getSubcommand(data), undefined);
});

test("truncate shortens long strings with ellipsis", () => {
  const result = truncate("hello world", 5);
  assert.ok(result.length <= 8);
  assert.ok(result.startsWith("hell"));
});

test("truncate keeps short strings as-is", () => {
  assert.equal(truncate("short", 10), "short");
});

test("utcNow returns ISO string", () => {
  const now = utcNow();
  assert.ok(now.endsWith("Z"));
  assert.ok(new Date(now).getTime() > 0);
});

test("snowflakeToDate converts Discord snowflake", () => {
  const date = snowflakeToDate("175928847299117063");
  assert.ok(date.endsWith("Z"));
  assert.ok(date.includes("T"));
  assert.ok(date.startsWith("2"));
});

test("snowflakeToDate throws for non-numeric input", () => {
  // BigInt throws SyntaxError for non-numeric strings
  assert.throws(() => snowflakeToDate("invalid"), /invalid|not a/);
});

test("permissionBits extracts bigint from interaction", () => {
  const interaction = { member: { permissions: 8n } };
  assert.equal(permissionBits(interaction), 8n);
});

test("permissionBits defaults to 0n", () => {
  assert.equal(permissionBits({}), 0n);
  assert.equal(permissionBits({ member: {} }), 0n);
});

test("hasPermission checks specific bit", () => {
  assert.ok(hasPermission({ member: { permissions: 8n } }, 8n));
  assert.equal(hasPermission({ member: { permissions: 8n } }, 1n), false);
});

test("isAdmin detects ADMINISTRATOR permission", () => {
  assert.ok(isAdmin({ member: { permissions: 8n } }));
  assert.equal(isAdmin({ member: { permissions: 0n } }), false);
});

test("isManageServer detects MANAGE_GUILD permission", () => {
  assert.ok(isManageServer({ member: { permissions: 0x20n } }));
  assert.equal(isManageServer({ member: { permissions: 8n } }), false);
});
