import assert from "node:assert/strict";
import test from "node:test";

import { handleInteraction } from "../src/worker.js";

test("handleInteraction is exported", () => {
  assert.equal(typeof handleInteraction, "function");
  assert.equal(handleInteraction.length, 3); // request, env, ctx
});

test("handleInteraction returns 401 for invalid signature", async () => {
  const request = new Request("https://example.com", { method: "POST", body: "{}" });
  const result = await handleInteraction(request, {}, {});
  assert.equal(result.status, 401);
});

// Test that exports from worker.js include the BotStorage class
import { BotStorage } from "../src/worker.js";
test("BotStorage class is exported", () => {
  assert.equal(typeof BotStorage, "function");
  // BotStorage is a Durable Object class with fetch method
  assert.equal(typeof BotStorage.prototype.fetch, "function");
});
