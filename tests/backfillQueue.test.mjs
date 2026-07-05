import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueManifestBackfill,
  recordMissingManifest,
  processBackfillRetryQueue,
  backfillQueueStatus
} from "../src/backfillQueue.js";

test("all backfill functions are exported", () => {
  assert.equal(typeof enqueueManifestBackfill, "function");
  assert.equal(typeof recordMissingManifest, "function");
  assert.equal(typeof processBackfillRetryQueue, "function");
  assert.equal(typeof backfillQueueStatus, "function");
});

test("enqueueManifestBackfill returns queued:false without BOT_STORAGE", async () => {
  const result = await enqueueManifestBackfill({}, { fileName: "test.cmf", url: "https://ex.com/file.cmf" });
  assert.ok(result);
  assert.equal(result.queued, false);
});

test("recordMissingManifest returns undefined without BOT_STORAGE (early return)", async () => {
  const result = await recordMissingManifest({}, { fileName: "test.cmf", source: "test" });
  assert.equal(result, undefined);
});

test("processBackfillRetryQueue returns ok:false without BOT_STORAGE", async () => {
  const result = await processBackfillRetryQueue({}, 5);
  assert.ok(result);
  assert.equal(result.ok, false);
});

test("backfillQueueStatus returns object without crashing", async () => {
  const status = await backfillQueueStatus({});
  assert.ok(typeof status === "object");
  assert.ok(status !== null);
});
