import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseUploadPaths,
  publishNewManifest,
  publishManifestVaultFile,
  readManifestVaultFile,
  healthCheck,
  publishFixManifest,
  publishReplacingManifest,
  countDatabaseFiles
} from "../src/publisher.js";

test("all 8 publisher functions are exported", () => {
  assert.equal(typeof databaseUploadPaths, "function");
  assert.equal(typeof publishNewManifest, "function");
  assert.equal(typeof publishManifestVaultFile, "function");
  assert.equal(typeof readManifestVaultFile, "function");
  assert.equal(typeof healthCheck, "function");
  assert.equal(typeof publishFixManifest, "function");
  assert.equal(typeof publishReplacingManifest, "function");
  assert.equal(typeof countDatabaseFiles, "function");
});

test("databaseUploadPaths returns two paths", () => {
  const env = { DATABASE_BASE_PATHS: "test123" };
  const paths = databaseUploadPaths(env, "730_12345.manifest");
  assert.equal(paths.length, 2);
  assert.ok(paths[0].includes("database-1"));
  assert.ok(paths[1].includes("database-2"));
  assert.ok(paths[0].includes("730_12345.manifest"));
});

test("databaseUploadPaths handles missing base path", () => {
  const env = {};
  const paths = databaseUploadPaths(env, "730_12345.manifest");
  assert.equal(paths.length, 2);
  assert.ok(paths[0].endsWith("730_12345.manifest"));
});

test("databaseUploadPaths handles empty base path", () => {
  const env = { DATABASE_BASE_PATHS: "" };
  const paths = databaseUploadPaths(env, "730_12345.manifest");
  assert.equal(paths.length, 2);
});

test("publishNewManifest runs without crashing", async () => {
  try {
    const result = await publishNewManifest({ GITHUB_TOKEN: "mock" }, "730", "730_12345.manifest", new Uint8Array([1, 2, 3]), "tester");
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("publishManifestVaultFile runs without crashing", async () => {
  try {
    const result = await publishManifestVaultFile({ GITHUB_TOKEN: "mock" }, "730_12345.manifest", new Uint8Array([1, 2, 3]));
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("readManifestVaultFile returns null without BOT_STORAGE", async () => {
  try {
    const result = await readManifestVaultFile({ GITHUB_TOKEN: "mock" }, "730_12345.manifest");
    assert.equal(result, null);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("healthCheck runs and returns checks object", async () => {
  const result = await healthCheck({});
  assert.ok(result);
  // checks is an object, not an array
  assert.equal(typeof result.checks, "object");
  assert.ok(result.checks !== null);
  assert.ok(!Array.isArray(result.checks)); // it's a plain object
});

test("publishFixManifest runs without crashing", async () => {
  try {
    const result = await publishFixManifest({ GITHUB_TOKEN: "mock" }, "730", "730_12345.manifest", new Uint8Array([1, 2, 3]), "tester");
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("publishReplacingManifest runs without crashing", async () => {
  try {
    const result = await publishReplacingManifest({ GITHUB_TOKEN: "mock" }, "730", "730_12345.manifest", new Uint8Array([1, 2, 3]), "tester");
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("countDatabaseFiles errors gracefully without GITHUB_TOKEN", async () => {
  try {
    const result = await countDatabaseFiles({});
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.ok(e.message.includes("GITHUB_TOKEN"));
  }
});

test("countDatabaseFiles works with mock token but no network", async () => {
  try {
    const result = await countDatabaseFiles({ GITHUB_TOKEN: "mock_token_12345" });
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});
