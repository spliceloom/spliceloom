import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { securityFlags } from "./features.js";
import { HOLDER_PASS_MS, holderMessage, issuePass, readPass, recoverSigner, verifyHolderSignature } from "./holder.js";
import { runTelegramAlerts, type AlertDeps } from "./telegram-alerts.js";
import { MAX_ALERTS_PER_CHAT, displayName, handleTelegramUpdate, telegramReply, type AlertRow, type AlertStore, type TelegramDeps } from "./telegram.js";

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

function memoryAlerts(): AlertStore & { rows: AlertRow[] } {
  const rows: AlertRow[] = [];
  let next = 1;
  return {
    rows,
    add: async (chatId, kind, value) => {
      if (kind === "whale" || kind === "burn" || kind === "radar") for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.chatId === chatId && rows[i]!.kind === kind) rows.splice(i, 1);
      rows.push({ id: next++, chatId, kind, value });
    },
    list: async (chatId) => rows.filter((r) => r.chatId === chatId),
    remove: async (chatId, which) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.chatId === chatId && (which === "all" || rows[i]!.id === which || rows[i]!.kind === which)) rows.splice(i, 1);
      return before - rows.length;
    },
    all: async () => [...rows],
    removeById: async (id) => void rows.splice(rows.findIndex((r) => r.id === id), 1),
  };
}

describe("telegram bot", () => {
  const base = (): TelegramDeps => ({
    token: async () => ({ address: "0xe617", priceUsd: 0.0000098, fdvUsd: 9800, holders: "70", pool: { liquidityUsd: 13300 }, burned: { total: "29088733", pctOfSupply: 2.91 }, market: { stats: { changePct: { h24: 5 }, volumeUsd: { h24: "64000" }, txns24: 950 } }, topHolders: [{ address: "0x9f9149e9aad34b75e77f0ae1023f8734706ca47e", pctOfSupply: 68.7, label: "Launch curve / pool" }], transparency: { deployer: { balance: "0" } } }),
    chain: async () => ({ tvl: { tvlUsd: 1_050_000_000, change1dPct: 1.5, change7dPct: 3, change30dPct: 33 }, perps: [{ symbol: "SPY", markPrice: 771, change24hPct: 0.2, volume24hUsd: 62_000_000, openInterestUsd: 44_000_000 }] }),
    stocks: async () => ({ session: "closed", tokens: [{ symbol: "AMC", dexPriceUsd: 2.78, referencePriceUsd: 2.77, premiumPct: 0.2, referenceSource: "last-close" }] }),
    screener: async () => ({ tokens: [{ symbol: "NEWT", liquidityUsd: 12000, volume24hUsd: 3000, flags: [{ level: "ok", text: "no GoPlus flags" }] }] }),
    wallet: async () => ({ native: { amount: 0.5, valueUsd: 1300 }, tokenCount: 3, pricedValueUsd: 1400, unpricedTokens: 2, holdings: [{ symbol: "SPLICE", address: "0xe617", amount: 1000000, valueUsd: 9.8 }] }),
    stock: async (s) => `stock ${s}`,
    check: async (a) => `check ${a}`,
    ask: async (q, chat) => `answer to "${q}" in ${chat}`,
  });

  it("introduces itself on /start and greets the user by name in every reply", async () => {
    const deps = base();
    const start = (await telegramReply("/start", "1", deps, "Dim"))!;
    assert.match(start, /^Hi Dim, I'm Splice\./);
    assert.match(start, /\/help/);
    for (const cmd of ["/splice", "/tvl", "/perps", "/stocks", "/new", "/holders", "/burned", "/ca", "/links", "/help", "/wallet 0xcd8de6826fdd342201eed382f9fd49b478e25d3d", "/stock nvda", "/ask what is tvl"]) {
      assert.match((await telegramReply(cmd, "1", deps, "Dim"))!, /Dim/, cmd);
    }
  });

  it("keeps names harmless: one line, no control characters, bounded length", () => {
    assert.equal(displayName({ first_name: "Dim" }), "Dim");
    assert.equal(displayName({ first_name: "  A\nB\u202e\u0000  " }), "AB");
    assert.equal(displayName({ first_name: "x".repeat(80) }).length, 32);
    assert.equal(displayName({ username: "dimxyz" }), "dimxyz");
    assert.equal(displayName(undefined), "there");
  });

  it("answers data commands from the live sources", async () => {
    const deps = base();
    assert.match((await telegramReply("/splice", "1", deps, "A"))!, /Market cap: \$9\.8K[\s\S]*Burned: 2\.91%/);
    assert.match((await telegramReply("/tvl@spliceloombot", "1", deps, "A"))!, /TVL is \$1\.05B/);
    assert.match((await telegramReply("/perps", "1", deps, "A"))!, /SPY {2}\$771\.00/);
    assert.match((await telegramReply("/stocks", "1", deps, "A"))!, /AMC {2}\$2\.78 vs \$2\.77 {2}\+0\.20% \(last close\)/);
    assert.match((await telegramReply("/new", "1", deps, "A"))!, /NEWT {2}liq \$12\.0K[\s\S]*not reviewed or endorsed/);
    assert.match((await telegramReply("/holders", "1", deps, "A"))!, /68\.70% {2}\(Launch curve \/ pool\)[\s\S]*Dev wallet \(deployer\): 0 SPLICE/);
    assert.match((await telegramReply("/wallet 0xcd8de6826fdd342201eed382f9fd49b478e25d3d", "1", deps, "A"))!, /Tokens held: 3[\s\S]*2 tokens have no price source/);
  });

  it("validates arguments and ignores messages that are not commands", async () => {
    const deps = base();
    assert.match((await telegramReply("/stock <script>", "1", deps, "A"))!, /\/stock NVDA/);
    assert.match((await telegramReply("/check 0x12", "1", deps, "A"))!, /\/check 0x/);
    assert.match((await telegramReply(`/ask ${"x".repeat(301)}`, "1", deps, "A"))!, /300 characters/);
    assert.equal(await telegramReply("hello there", "1", deps, "A"), null);
    assert.equal(await telegramReply("/unknown", "1", deps, "A"), null);
  });

  it("manages alerts per chat, with a cap", async () => {
    const alerts = memoryAlerts();
    const deps = { ...base(), alerts };
    assert.match((await telegramReply("/alert above 0.00002", "7", deps, "A"))!, /Alert set: \$SPLICE price at or above \$0\.00002000/);
    assert.match((await telegramReply("/alert sideways 1", "7", deps, "A"))!, /Usage/);
    assert.match((await telegramReply("/whales on 250", "7", deps, "A"))!, /On: \$SPLICE trades of \$250\.00 or more/);
    assert.match((await telegramReply("/whales on 500", "7", deps, "A"))!, /\$500\.00/);
    assert.equal(alerts.rows.filter((r) => r.kind === "whale").length, 1, "one whale alert per chat");
    assert.match((await telegramReply("/whales on 1", "7", deps, "A"))!, /minimum is \$10\.00/);
    assert.match((await telegramReply("/burns on", "7", deps, "A"))!, /every new \$SPLICE burn/);
    assert.match((await telegramReply("/radar on", "7", deps, "A"))!, /\$10\.0K\+ liquidity/);
    const list = (await telegramReply("/alerts", "7", deps, "A"))!;
    assert.match(list, /1\. \$SPLICE price at or above/);
    assert.equal((await alerts.list("8")).length, 0, "another chat sees nothing");
    assert.match((await telegramReply("/alertoff 1", "7", deps, "A"))!, /Removed 1 alert/);
    assert.match((await telegramReply("/burns off", "7", deps, "A"))!, /Turned off burn alerts/);
    assert.match((await telegramReply("/alertoff all", "7", deps, "A"))!, /Removed 2 alerts/);
    for (let i = 0; i < MAX_ALERTS_PER_CHAT; i++) await telegramReply(`/alert above ${i + 1}`, "9", deps, "A");
    assert.match((await telegramReply("/alert above 99", "9", deps, "A"))!, /already has 10 alerts/);
    assert.match((await telegramReply("/alerts", "1", base(), "A"))!, /not available/);
  });

  it("wraps replies as a webhook sendMessage call and survives failures", async () => {
    const deps = base();
    const ok = await handleTelegramUpdate({ message: { text: "/start", chat: { id: 7 }, message_id: 3, from: { first_name: "Dim" } } }, deps);
    assert.equal(ok.method, "sendMessage");
    assert.equal(ok.chat_id, 7);
    assert.match(String(ok.text), /^Hi Dim, I'm Splice/);
    assert.deepEqual(await handleTelegramUpdate({ message: { text: "just chatting", chat: { id: 7 } } }, deps), {});
    assert.deepEqual(await handleTelegramUpdate({ edited_message: {} }, deps), {});
    const failing = await handleTelegramUpdate({ message: { text: "/splice", chat: { id: 7 }, from: { first_name: "Dim" } } }, { ...deps, token: async () => Promise.reject(new Error("down")) });
    assert.match(String(failing.text), /Sorry Dim, that did not work/);
  });
});

describe("scheduled telegram alerts", () => {
  const setup = () => {
    const store = memoryAlerts();
    const kv = new Map<string, unknown>();
    const sent: Array<[string, string]> = [];
    const world = { price: 0.00001, block: 100, swaps: [] as Array<Record<string, unknown>>, burned: 1000, pools: [] as Array<Record<string, unknown>>, clock: Date.parse("2026-10-04T12:00:00Z") };
    const deps: AlertDeps = {
      store,
      state: { get: async <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null), set: async (k, v) => void kv.set(k, v) },
      live: async () => ({ status: "LIVE", priceUsd: world.price, block: world.block, swaps: world.swaps }),
      token: async () => ({ burned: { total: String(world.burned), pctOfSupply: 3.1 } }),
      screener: async () => ({ tokens: world.pools }),
      send: async (chat, text) => (sent.push([chat, text]), true),
      now: () => world.clock,
    };
    return { store, sent, world, deps };
  };

  it("does nothing, and reads nothing, while nobody is subscribed", async () => {
    const { deps } = setup();
    const untouched: AlertDeps = { ...deps, live: async () => Promise.reject(new Error("must not be read")) };
    assert.deepEqual(await runTelegramAlerts(untouched), { alerts: 0, sent: 0 });
  });

  it("fires a price alert once and removes it", async () => {
    const { store, sent, world, deps } = setup();
    await store.add("1", "above", 0.00002);
    await store.add("1", "below", 0.000005);
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 0);
    world.price = 0.000021;
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 1);
    assert.match(sent[0]![1], /at or above \$0\.00002000[\s\S]*now \$0\.00002100/);
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 1, "not sent again");
    assert.deepEqual((await store.list("1")).map((a) => a.kind), ["below"]);
  });

  it("reports only trades newer than the last run and at or above each chat's minimum", async () => {
    const { store, sent, world, deps } = setup();
    await store.add("1", "whale", 100);
    await store.add("2", "whale", 1000);
    world.swaps = [{ type: "Buy", valueUsd: 500, splice: 5e7, priceUsd: 0.00001, wallet: "0xcd8de6826fdd342201eed382f9fd49b478e25d3d", txHash: "0xaaa", block: 90 }];
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 0, "the first run only sets the marker");
    world.block = 200;
    world.swaps = [
      { type: "Sell", valueUsd: 50, splice: 5e6, priceUsd: 0.00001, wallet: "0x1", txHash: "0xccc", block: 150 },
      { type: "Buy", valueUsd: 1500, splice: 1.5e8, priceUsd: 0.00001, wallet: "0xcd8de6826fdd342201eed382f9fd49b478e25d3d", txHash: "0xbbb", block: 140 },
      ...world.swaps,
    ];
    await runTelegramAlerts(deps);
    assert.deepEqual(sent.map(([chat]) => chat).sort(), ["1", "2"]);
    assert.match(sent[0]![1], /BUY \$1\.5K[\s\S]*0xbbb/);
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 2, "already reported");
  });

  it("announces a burn when the burned balance grows", async () => {
    const { store, sent, world, deps } = setup();
    await store.add("1", "burn", null);
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 0);
    world.burned = 6000;
    await runTelegramAlerts(deps);
    assert.match(sent[0]![1], /new \$SPLICE burn[\s\S]*5,000 SPLICE[\s\S]*6,000 SPLICE/);
  });

  it("sends new pools above the chat's liquidity, at most every 10 minutes", async () => {
    const { store, sent, world, deps } = setup();
    await store.add("1", "radar", 10_000);
    await runTelegramAlerts(deps);
    world.pools = [
      { symbol: "BIG", address: "0x1", liquidityUsd: 50_000, volume24hUsd: 1000, createdAt: new Date(world.clock + 60_000).toISOString(), flags: [{ level: "ok", text: "no GoPlus flags" }] },
      { symbol: "TINY", address: "0x2", liquidityUsd: 500, volume24hUsd: 10, createdAt: new Date(world.clock + 60_000).toISOString(), flags: null },
    ];
    world.clock += 5 * 60_000;
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 0, "too soon");
    world.clock += 6 * 60_000;
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 1);
    assert.match(sent[0]![1], /new token BIG[\s\S]*no GoPlus flags[\s\S]*not reviewed or endorsed/);
  });
});