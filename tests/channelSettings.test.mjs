import assert from "node:assert/strict";
import test from "node:test";
import {
  getChannelSetting,
  listChannelSettings,
  requireCommandChannel,
  setChannelSetting
} from "../src/channelSettings.js";

function storageEnv(initial = {}) {
  const store = { ...initial };
  return {
    REQUEST_CHANNEL: "111111111111111111",
    MOD_LOG_CHANNEL: "222222222222222222",
    GAMES_ADDED_CHANNEL: "333333333333333333",
    TICKET_LOG_CHANNEL: "444444444444444444",
    BOT_STORAGE: {
      idFromName: () => "global",
        get: () => ({
          fetch: async (_url, request) => {
            const body = JSON.parse(request.body || "{}");
            if (body.op === "get") return Response.json({ value: store[body.key] ?? body.fallback });
            if (body.op === "put") {
            store[body.key] = body.value;
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        }
      })
    },
    _store: store
  };
}

test("channel settings read env defaults and stored overrides", async () => {
  const env = storageEnv();
  assert.equal(await getChannelSetting(env, "request"), "111111111111111111");
  await setChannelSetting(env, "request", "555555555555555555");
  assert.equal(await getChannelSetting(env, "request"), "555555555555555555");

  const list = await listChannelSettings(env);
  assert.equal(list.some((item) => item.type === "request" && item.channelId === "555555555555555555"), true);
});

test("gen/request/fix command channel restriction is enforced when configured", async () => {
  const env = storageEnv({ "channel.gen": "999999999999999999" });
  await assert.rejects(
    () => requireCommandChannel(env, { channel_id: "888888888888888888" }, "gen"),
    /Use `\/gen` in <#999999999999999999>/
  );
  await assert.doesNotReject(
    () => requireCommandChannel(env, { channel_id: "999999999999999999" }, "request")
  );
});
