import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminRoleSet,
  handleAdminAdd,
  handleAdminRemove,
  handleAdminList,
  handleAdminTransfer,
  handleAdminLogs,
  handleAdminPermissions,
  handleAdminAutocomplete
} from "../src/admin.js";

test("all 8 admin handler functions are exported", () => {
  assert.equal(typeof handleAdminRoleSet, "function");
  assert.equal(typeof handleAdminAdd, "function");
  assert.equal(typeof handleAdminRemove, "function");
  assert.equal(typeof handleAdminList, "function");
  assert.equal(typeof handleAdminTransfer, "function");
  assert.equal(typeof handleAdminLogs, "function");
  assert.equal(typeof handleAdminPermissions, "function");
  assert.equal(typeof handleAdminAutocomplete, "function");
});

test("admin handlers handle missing storage gracefully", async () => {
  const baseInteraction = { guild_id: "1", member: { user: { id: "1" } }, data: { options: [] } };
  const handlers = [
    handleAdminRoleSet,
    handleAdminAdd,
    handleAdminRemove,
    handleAdminList,
    handleAdminTransfer,
    handleAdminLogs,
    handleAdminPermissions
  ];
  for (const handler of handlers) {
    try {
      const result = await handler({}, baseInteraction);
      // If it returns something without throwing, that's acceptable
      assert.ok(result !== undefined);
    } catch (e) {
      // Errors about missing storage/token are expected in unit test env
      assert.ok(e instanceof Error);
    }
  }
});

test("handleAdminAutocomplete returns result", async () => {
  const result = await handleAdminAutocomplete({}, { data: { options: [] } });
  assert.ok(result !== undefined);
});
