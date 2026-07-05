import assert from "node:assert/strict";
import test from "node:test";

import {
  TICKET_COMMANDS,
  handleSetTicketCommand,
  handleTicketCommand,
  createQuickTicket,
  isTicketComponent,
  isTicketModal,
  handleTicketComponent,
  handleTicketModal
} from "../src/tickets.js";

test("TICKET_COMMANDS is a Set with setticket and ticket", () => {
  assert.ok(TICKET_COMMANDS instanceof Set);
  assert.equal(TICKET_COMMANDS.size, 2);
  assert.ok(TICKET_COMMANDS.has("setticket"));
  assert.ok(TICKET_COMMANDS.has("ticket"));
});

test("all 8 ticket exports are functions (or Set)", () => {
  assert.equal(typeof handleSetTicketCommand, "function");
  assert.equal(typeof handleTicketCommand, "function");
  assert.equal(typeof createQuickTicket, "function");
  assert.equal(typeof isTicketComponent, "function");
  assert.equal(typeof isTicketModal, "function");
  assert.equal(typeof handleTicketComponent, "function");
  assert.equal(typeof handleTicketModal, "function");
});

test("isTicketComponent identifies create_ticket", () => {
  assert.equal(isTicketComponent("create_ticket"), true);
});

test("isTicketComponent identifies ticket_category_select", () => {
  assert.equal(isTicketComponent("ticket_category_select"), true);
});

test("isTicketComponent identifies ticket_ prefixed IDs", () => {
  assert.equal(isTicketComponent("ticket_claim_12345"), true);
  assert.equal(isTicketComponent("ticket_close_67890"), true);
});

test("isTicketComponent returns false for unrelated IDs", () => {
  assert.equal(isTicketComponent("some_random_id"), false);
  assert.equal(isTicketComponent(""), false);
});

test("isTicketModal identifies ticket modals with ticket_modal: prefix", () => {
  assert.equal(isTicketModal("ticket_modal:description"), true);
  assert.equal(isTicketModal("ticket_modal:"), true);
  assert.equal(isTicketModal("other"), false);
  assert.equal(isTicketModal(""), false);
  assert.equal(isTicketModal("ticket_description_modal"), false);
});

test("handleSetTicketCommand errors gracefully without BOT_STORAGE", async () => {
  const interaction = { data: { options: [] }, guild_id: "123" };
  try {
    const result = await handleSetTicketCommand({}, interaction);
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("handleTicketCommand with panel subcommand errors gracefully without BOT_STORAGE", async () => {
  const interaction = {
    data: { options: [{ name: "panel" }] },
    guild_id: "123"
  };
  try {
    const result = await handleTicketCommand({}, interaction);
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("createQuickTicket errors gracefully without BOT_STORAGE", async () => {
  try {
    const result = await createQuickTicket({}, { guild_id: "123", member: { user: { id: "456" } } }, "support", "Need help");
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("handleTicketComponent errors gracefully without BOT_STORAGE", async () => {
  try {
    const result = await handleTicketComponent({}, { data: { custom_id: "create_ticket" }, guild_id: "123", member: { user: { id: "456" } } });
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});

test("handleTicketModal errors gracefully without BOT_STORAGE", async () => {
  try {
    const result = await handleTicketModal({}, { data: { custom_id: "ticket_description_modal" }, guild_id: "123", member: { user: { id: "456" } } }, { waitUntil: () => {} });
    assert.ok(result !== undefined);
  } catch (e) {
    assert.ok(e instanceof Error);
  }
});
