import assert from "node:assert/strict";
import test from "node:test";
import { sendChannelMessage } from "../src/discord.js";

test("sendChannelMessage rawContent sends plain text without an automatic embed", async () => {
  const originalFetch = globalThis.fetch;
  let payload = null;

  globalThis.fetch = async (_url, options = {}) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "message" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await sendChannelMessage({ DISCORD_TOKEN: "token" }, "123", "plain message", { rawContent: true });
    assert.equal(payload.content, "plain message");
    assert.deepEqual(payload.embeds, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendChannelMessage default mode keeps simple replies embedded", async () => {
  const originalFetch = globalThis.fetch;
  let payload = null;

  globalThis.fetch = async (_url, options = {}) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "message" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await sendChannelMessage({ DISCORD_TOKEN: "token" }, "123", "status message");
    assert.equal(payload.content, "");
    assert.equal(payload.embeds.length, 1);
    assert.match(payload.embeds[0].description, /status message/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
