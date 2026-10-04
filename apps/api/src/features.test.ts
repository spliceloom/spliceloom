import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { securityFlags } from "./features.js";
import { HOLDER_PASS_MS, holderMessage, issuePass, readPass, recoverSigner, verifyHolderSignature } from "./holder.js";
import { handleTelegramUpdate, telegramReply, type TelegramDeps } from "./telegram.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A wallet for tests: signs like MetaMask's personal_sign. */
function wallet() {
  const priv = secp256k1.utils.randomPrivateKey();
  const address = `0x${hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20))}`;
  const sign = (message: string) => {
    const body = new TextEncoder().encode(message);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
    const sig = secp256k1.sign(digest, priv);
    return `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, sign };
}

describe("holder access", () => {
  const now = Date.parse("2026-10-04T10:00:00Z");

  it("recovers the signer of a personal_sign message", () => {
    const w = wallet();
    assert.equal(recoverSigner("hello", w.sign("hello")), w.address);
    assert.notEqual(recoverSigner("other text", w.sign("hello")), w.address);
    assert.equal(recoverSigner("hello", "0x1234"), null);
  });

  it("accepts a fresh message signed by the named wallet, and nothing else", () => {
    const w = wallet();
    const issuedAt = new Date(now).toISOString();
    const signature = w.sign(holderMessage(w.address, issuedAt));
    assert.deepEqual(verifyHolderSignature({ address: w.address, issuedAt, signature }, now), { ok: true, address: w.address });
    // Someone else's signature, a different address, or an old message are refused.
    const other = wallet();
    assert.equal(verifyHolderSignature({ address: w.address, issuedAt, signature: other.sign(holderMessage(w.address, issuedAt)) }, now).ok, false);
    assert.equal(verifyHolderSignature({ address: other.address, issuedAt, signature }, now).ok, false);
    assert.equal(verifyHolderSignature({ address: w.address, issuedAt, signature }, now + 11 * 60_000).ok, false);
    assert.equal(verifyHolderSignature({ address: "0x123", issuedAt, signature }, now).ok, false);
  });

  it("issues passes that cannot be forged, altered or used after they expire", async () => {
    const secret = "s".repeat(40);
    const { pass, expiresAt } = await issuePass(secret, "0xAbC0000000000000000000000000000000000001", now);
    assert.equal(expiresAt, now + HOLDER_PASS_MS);
    assert.equal(await readPass(secret, pass, now), "0xabc0000000000000000000000000000000000001");
    assert.equal(await readPass("x".repeat(40), pass, now), null, "another secret");
    assert.equal(await readPass(secret, pass.replace("0xabc", "0xabd"), now), null, "another address");
    assert.equal(await readPass(secret, pass, expiresAt + 1), null, "expired");
    assert.equal(await readPass(secret, "garbage", now), null);
  });
});

describe("security flags", () => {
  it("maps GoPlus fields to flags and reports a clean token as ok", () => {
    assert.equal(securityFlags(undefined), null);
    assert.deepEqual(securityFlags({ is_honeypot: "0", sell_tax: "0", is_open_source: "1" }), [{ level: "ok", text: "no GoPlus flags" }]);
    const flags = securityFlags({ is_honeypot: "1", sell_tax: "0.25", buy_tax: "0.05", is_mintable: "1", is_open_source: "0" })!;
    assert.deepEqual(flags.map((f) => `${f.level}:${f.text}`), ["danger:honeypot", "warn:mintable", "warn:buy tax 5%", "danger:sell tax 25%", "warn:source not verified"]);
  });
});

describe("telegram bot", () => {
  const deps: TelegramDeps = {
    token: async () => ({ address: "0xe617", priceUsd: 0.0000098, fdvUsd: 9800, holders: "70", pool: { liquidityUsd: 13300 }, burned: { pctOfSupply: 2.91 }, market: { stats: { changePct: { h24: 5 } } } }),
    chain: async () => ({ tvl: { tvlUsd: 1_050_000_000, change1dPct: 1.5, change30dPct: 33 }, perps: [{ symbol: "SPY", volume24hUsd: 62_000_000 }] }),
    stock: async (s) => `stock ${s}`,
    check: async (a) => `check ${a}`,
    ask: async (q, chat) => `answer to "${q}" in ${chat}`,
  };

  it("answers commands with plain text built from the live data", async () => {
    assert.match((await telegramReply("/splice", "1", deps))!, /Market cap: \$9\.8K[\s\S]*Burned: 2\.91%/);
    assert.match((await telegramReply("/tvl@SpliceBot", "1", deps))!, /TVL: \$1\.05B[\s\S]*SPY \$62\.00M/);
    assert.equal(await telegramReply("/stock nvda", "1", deps), "stock NVDA");
    assert.equal(await telegramReply("/ask what is tvl", "42", deps), 'answer to "what is tvl" in 42');
    assert.match((await telegramReply("/help", "1", deps))!, /\/splice/);
  });

  it("validates arguments and ignores messages that are not commands", async () => {
    assert.match((await telegramReply("/stock <script>", "1", deps))!, /Usage/);
    assert.match((await telegramReply("/check 0x12", "1", deps))!, /Usage/);
    assert.match((await telegramReply(`/ask ${"x".repeat(301)}`, "1", deps))!, /300 characters/);
    assert.equal(await telegramReply("hello there", "1", deps), null);
    assert.equal(await telegramReply("/unknown", "1", deps), null);
  });

  it("wraps replies as a webhook sendMessage call and survives failures", async () => {
    const ok = await handleTelegramUpdate({ message: { text: "/help", chat: { id: 7 }, message_id: 3 } }, deps);
    assert.equal(ok.method, "sendMessage");
    assert.equal(ok.chat_id, 7);
    assert.equal(ok.disable_web_page_preview, true);
    assert.deepEqual(await handleTelegramUpdate({ message: { text: "just chatting", chat: { id: 7 } } }, deps), {});
    assert.deepEqual(await handleTelegramUpdate({ edited_message: {} }, deps), {});
    const failing = await handleTelegramUpdate({ message: { text: "/splice", chat: { id: 7 } } }, { ...deps, token: async () => Promise.reject(new Error("down")) });
    assert.match(String(failing.text), /did not work/);
  });
});
