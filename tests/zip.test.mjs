import assert from "node:assert/strict";
import test from "node:test";
import { createLuaZip, crc32 } from "../src/zip.js";

test("crc32 matches known value", () => {
  assert.equal(crc32(new TextEncoder().encode("hello")), 0x3610a686);
});

test("createLuaZip creates a valid zip signature", () => {
  const zip = createLuaZip("480", new TextEncoder().encode("print('ok')"));
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const text = new TextDecoder().decode(zip);
  assert.match(text, /480\.lua/);
});
