import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import worker from "../src/worker.js";

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedRequest(body, keyPair) {
  const timestamp = "1700000000";
  const encoded = new TextEncoder().encode(`${timestamp}${body}`);
  const signature = nacl.sign.detached(encoded, keyPair.secretKey);
  return new Request("https://bot.example/", {
    method: "POST",
    headers: {
      "x-signature-ed25519": hex(signature),
      "x-signature-timestamp": timestamp,
      "content-type": "application/json"
    },
    body
  });
}

test("gen autocomplete returns Steam game name suggestions", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("store.steampowered.com/search/suggest")) {
      return new Response(`
        <a href="https://store.steampowered.com/app/4000/Garrys_Mod/">
          <div class="match_name">Garry's Mod</div>
        </a>
      `, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const body = JSON.stringify({
      type: 4,
      data: {
        name: "gen",
        options: [{ name: "appid", type: 3, value: "gar", focused: true }]
      }
    });
    const response = await worker.fetch(signedRequest(body, keyPair), {
      DISCORD_PUBLIC_KEY: hex(keyPair.publicKey)
    }, { waitUntil() {} });
    const data = await response.json();

    assert.equal(data.type, 8);
    assert.deepEqual(data.data.choices, [{ name: "Garry's Mod (4000)", value: "4000" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
