import assert from "node:assert/strict";
import test from "node:test";
import {
  messageResponse,
  deferredResponse,
  deferredUpdateResponse,
  modalResponse,
  updateMessageResponse,
  autocompleteResponse,
  interactionUser,
  FLAGS,
  InteractionResponseType
} from "../src/discord.js";

test("messageResponse returns JSON with content via standardEmbed", async () => {
  const res = messageResponse("hello");
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  // content is empty by default (rawContent=false), embed contains the message
  assert.equal(body.data.content, "");
  assert.ok(body.data.embeds);
  assert.equal(body.data.embeds[0].title, "Colorado State RP");
  assert.ok(body.data.embeds[0].description.includes("hello"));
});

test("messageResponse with rawContent puts text in content", async () => {
  const res = messageResponse("raw text", true, { rawContent: true });
  const body = JSON.parse(await res.text());
  assert.equal(body.data.content, "raw text");
  // Should have no embeds when rawContent is true
  assert.deepEqual(body.data.embeds, []);
});

test("messageResponse is ephemeral by default", async () => {
  const res = messageResponse("secret");
  const body = JSON.parse(await res.text());
  assert.equal(body.data.flags, FLAGS.EPHEMERAL);
});

test("messageResponse can be public", async () => {
  const res = messageResponse("public", false);
  const body = JSON.parse(await res.text());
  assert.equal(body.data.flags, undefined);
});

test("messageResponse accepts custom embeds", async () => {
  const res = messageResponse("", true, { embeds: [{ title: "Custom" }] });
  const body = JSON.parse(await res.text());
  assert.equal(body.data.embeds[0].title, "Custom");
});

test("deferredResponse returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE", async () => {
  const res = deferredResponse();
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
});

test("deferredResponse is ephemeral by default", async () => {
  const res = deferredResponse();
  const body = JSON.parse(await res.text());
  assert.equal(body.data.flags, FLAGS.EPHEMERAL);
});

test("deferredResponse can be public", async () => {
  const res = deferredResponse(false);
  const body = JSON.parse(await res.text());
  assert.equal(body.data.flags, undefined);
});

test("deferredUpdateResponse returns DEFERRED_UPDATE_MESSAGE", async () => {
  const res = deferredUpdateResponse();
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);
});

test("modalResponse returns MODAL type", async () => {
  const res = modalResponse("my_custom_id", "My Title", [{ type: 1, components: [] }]);
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.MODAL);
  assert.equal(body.data.custom_id, "my_custom_id");
  assert.equal(body.data.title, "My Title");
});

test("updateMessageResponse returns UPDATE_MESSAGE type", async () => {
  const res = updateMessageResponse({ content: "updated" });
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.UPDATE_MESSAGE);
  // content is empty unless rawContent is true
  assert.equal(body.data.content, "");
});

test("updateMessageResponse with rawContent", async () => {
  const res = updateMessageResponse({ content: "raw updated", rawContent: true });
  const body = JSON.parse(await res.text());
  assert.equal(body.data.content, "raw updated");
});

test("autocompleteResponse returns empty choices by default", async () => {
  const res = autocompleteResponse();
  const body = JSON.parse(await res.text());
  assert.equal(body.type, InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
  assert.deepEqual(body.data.choices, []);
});

test("autocompleteResponse formats choices", async () => {
  const res = autocompleteResponse([
    { name: "Elden Ring (1245620)", value: "1245620" }
  ]);
  const body = JSON.parse(await res.text());
  assert.equal(body.data.choices.length, 1);
  assert.equal(body.data.choices[0].name, "Elden Ring (1245620)");
  assert.equal(body.data.choices[0].value, "1245620");
});

test("autocompleteResponse limits to 25 choices", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `Game ${i}`, value: String(i) }));
  const res = autocompleteResponse(many);
  const body = JSON.parse(await res.text());
  assert.equal(body.data.choices.length, 25);
});

test("FLAGS contains EPHEMERAL", () => {
  assert.equal(FLAGS.EPHEMERAL, 64);
});

test("interactionUser extracts user from interaction", () => {
  const interaction = { member: { user: { id: "123", username: "test" } } };
  assert.deepEqual(interactionUser(interaction), { id: "123", username: "test" });
});

test("interactionUser falls back to user field", () => {
  const interaction = { user: { id: "456", username: "dm_user" } };
  assert.deepEqual(interactionUser(interaction), { id: "456", username: "dm_user" });
});
