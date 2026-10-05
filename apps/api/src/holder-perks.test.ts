import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpliceData } from "@spliceloom/data";
import { burnHistory, createApiHandler, type HolderLinks } from "./handler.js";
import { issuePass, readTelegramLinkCode, telegramLinkCode } from "./holder.js";
import { runTelegramAlerts, type AlertDeps } from "./telegram-alerts.js";
import { EARLY_ACCESS, MAX_ALERTS_PER_CHAT, MAX_ALERTS_PER_HOLDER_CHAT, telegramReply, type AlertKind, type AlertRow, type AlertStore, type TelegramDeps } from "./telegram.js";

const SECRET = "s".repeat(40);
const ORIGIN = "https://spliceloom.com";
const WALLET = `0x${"ab".repeat(20)}`;
const BEFORE = Date.parse(EARLY_ACCESS.premium!) - 3_600_000;
const AFTER = Date.parse(EARLY_ACCESS.premium!) + 3_600_000;

function memoryAlerts(): AlertStore & { rows: AlertRow[] } {
  const rows: AlertRow[] = [];
  let next = 1;
  const single: AlertKind[] = ["whale", "burn", "radar", "premium"];
  return {
    rows,
    add: async (chatId, kind, value) => {
      if (single.includes(kind)) for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.chatId === chatId && rows[i]!.kind === kind) rows.splice(i, 1);
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

describe("telegram link codes", () => {
  it("only accept codes the bot produced for that chat", async () => {
    const code = await telegramLinkCode(SECRET, "12345");
    assert.equal(await readTelegramLinkCode(SECRET, code), "12345");
    assert.equal(await readTelegramLinkCode(SECRET, await telegramLinkCode(SECRET, "-100200300")), "-100200300");
    assert.equal(await readTelegramLinkCode(SECRET, code.replace("12345", "12346")), null);
    assert.equal(await readTelegramLinkCode("other".repeat(8), code), null);
    assert.equal(await readTelegramLinkCode(SECRET, "12345"), null);
    assert.equal(await readTelegramLinkCode(SECRET, "abc.def"), null);
  });
});

describe("holder perks in the bot", () => {
  const deps = (holder: TelegramDeps["holder"], now: number, alerts = memoryAlerts()): TelegramDeps =>
    ({ alerts, holder, holderLink: async (chat: string) => `https://spliceloom.com/ask?tg=${chat}.code`, now: () => now }) as unknown as TelegramDeps;
  const yes: TelegramDeps["holder"] = async () => ({ address: WALLET, holder: true });
  const sold: TelegramDeps["holder"] = async () => ({ address: WALLET, holder: false });
  const none: TelegramDeps["holder"] = async () => null;

  it("explains /holder: how to link, what a linked holder gets, and when the wallet no longer qualifies", async () => {
    const fresh = await telegramReply("/holder", "7", deps(none, BEFORE), "Alex");
    assert.match(fresh!, /link a wallet that holds 100,000\+ \$SPLICE/);
    assert.match(fresh!, /no transaction, no gas, no approval/);
    assert.match(fresh!, /https:\/\/spliceloom\.com\/ask\?tg=7\.code$/);
    assert.match((await telegramReply("/holder", "7", deps(yes, BEFORE), "Alex"))!, /linked to 0xabab…abab, which holds enough \$SPLICE[\s\S]*Open to holders now: \/premium/);
    assert.match((await telegramReply("/holder", "7", deps(sold, BEFORE), "Alex"))!, /no longer holds 100,000 \$SPLICE[\s\S]*ask\?tg=7\.code/);
  });

  it("opens premium alerts to holders first and to everyone from the published date", async () => {
    const refused = await telegramReply("/premium on 2", "7", deps(none, BEFORE), "Alex");
    assert.match(refused!, new RegExp(`open to \\$SPLICE holders first, and to everyone from ${EARLY_ACCESS.premium!.slice(0, 10)}`));
    assert.match((await telegramReply("/premium on 2", "7", deps(sold, BEFORE), "Alex"))!, /holders first/);
    assert.match((await telegramReply("/premium on 2", "7", deps(yes, BEFORE), "Alex"))!, /On: stock tokens 2\.0%\+ away from their reference price/);
    assert.match((await telegramReply("/premium on 3.5", "7", deps(none, AFTER), "Alex"))!, /On: stock tokens 3\.5%\+ away/);
    assert.match((await telegramReply("/premium on 0.1", "7", deps(yes, BEFORE), "Alex"))!, /minimum is 0\.5%/);
    assert.match((await telegramReply("/premium", "7", deps(yes, BEFORE), "Alex"))!, /Usage: \/premium on 2/);
  });

  it("gives holder chats more alerts", async () => {
    const fill = async (holder: TelegramDeps["holder"]) => {
      const alerts = memoryAlerts();
      const d = deps(holder, BEFORE, alerts);
      let last = "";
      for (let i = 0; i < MAX_ALERTS_PER_HOLDER_CHAT + 1; i++) last = (await telegramReply(`/alert above ${1 + i}`, "7", d, "Alex"))!;
      return { count: alerts.rows.length, last };
    };
    const visitor = await fill(none);
    assert.equal(visitor.count, MAX_ALERTS_PER_CHAT);
    assert.match(visitor.last, /link a holder wallet for 30: \/holder/);
    const holder = await fill(yes);
    assert.equal(holder.count, MAX_ALERTS_PER_HOLDER_CHAT);
    assert.doesNotMatch(holder.last, /\/holder/);
  });
});

describe("premium alerts", () => {
  it("lists tokens past the chat's threshold, at most once per chat every 6 hours", async () => {
    const store = memoryAlerts();
    await store.add("1", "premium", 2);
    await store.add("2", "premium", 10);
    const kv = new Map<string, unknown>();
    const sent: Array<[string, string]> = [];
    let clock = Date.parse("2026-10-05T12:00:00Z");
    const deps: AlertDeps = {
      store,
      state: { get: async <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null), set: async (k, v) => void kv.set(k, v) },
      live: async () => Promise.reject(new Error("not needed")),
      token: async () => Promise.reject(new Error("not needed")),
      screener: async () => Promise.reject(new Error("not needed")),
      stocks: async () => ({ session: "closed", tokens: [{ symbol: "AAA", dexPriceUsd: 105, referencePriceUsd: 100, premiumPct: 5, referenceSource: "last-close" }, { symbol: "BBB", dexPriceUsd: 97, referencePriceUsd: 100, premiumPct: -3 }, { symbol: "CCC", dexPriceUsd: 100.5, referencePriceUsd: 100, premiumPct: 0.5 }, { symbol: "DDD", dexPriceUsd: 1, referencePriceUsd: null, premiumPct: null }] }),
      send: async (chat, text) => (sent.push([chat, text]), true),
      now: () => clock,
    };
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]![0], "1");
    assert.match(sent[0]![1], /AAA {2}DEX \$105\.00 vs \$100\.00 {2}\+5\.00% \(last close\)\nBBB {2}DEX \$97\.00 vs \$100\.00 {2}-3\.00%\nUS market closed/);
    assert.doesNotMatch(sent[0]![1], /CCC|DDD/);
    clock += 3_600_000;
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 1, "not repeated within 6 hours");
    clock += 6 * 3_600_000;
    await runTelegramAlerts(deps);
    assert.equal(sent.length, 2);
  });
});

describe("linking a wallet to a Telegram chat", () => {
  const links = new Map<string, string>();
  const holderLinks: HolderLinks = { get: async (chat) => links.get(chat) ?? null, set: async (chat, address) => void links.set(chat, address) };
  let balance = 500_000n * 10n ** 18n;
  const data = () => ({ onchain: { call: async () => ({ status: "LIVE", data: { result: `0x${balance.toString(16).padStart(64, "0")}` }, provenance: { source: "test" } }) } }) as unknown as SpliceData;
  const handle = createApiHandler({ data, origins: [ORIGIN], holderSecret: SECRET, holderLinks });
  const link = (body: unknown, origin: string | null = ORIGIN) => handle(new Request("https://api.spliceloom.com/v1/holder/link", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), "c");

  it("needs a valid holder pass and a code from the bot", async () => {
    const pass = (await issuePass(SECRET, WALLET, Date.now())).pass;
    const tg = await telegramLinkCode(SECRET, "777");
    assert.equal((await link({ pass, tg }, "https://evil.example")).status, 403);
    assert.equal((await link({ pass: "nope", tg })).status, 403);
    assert.equal((await link({ pass, tg: "777.deadbeef" })).status, 400);
    assert.equal(links.size, 0);
    const ok = await link({ pass, tg });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { linked: true, address: WALLET });
    assert.equal(links.get("777"), WALLET);
    // A wallet that sold cannot link, even with a pass issued earlier.
    balance = 10n * 10n ** 18n;
    assert.equal((await link({ pass, tg: await telegramLinkCode(SECRET, "888") })).status, 403);
    assert.equal(links.has("888"), false);
  });
});

describe("burn history", () => {
  it("lists the deployer's transfers into the dead address with the purchase just before each", async () => {
    const deployer = `0x${"11".repeat(20)}`;
    const ca = "0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806";
    const dead = "0x000000000000000000000000000000000000dEaD";
    const t = (hash: string, from: string, to: string, formatted: string, token = ca) => ({ hash, timestamp: "2026-10-04T00:00:00Z", from, to, formatted, token: { address: token } });
    const data = {
      onchain: {
        call: async () => ({ status: "LIVE", data: { result: `0x${"0".repeat(24)}${deployer.slice(2)}` }, provenance: { source: "rpc" } }),
        transfers: async () => ({
          status: "LIVE",
          provenance: { source: "blockscout" },
          data: { transfers: [t("0xb2", deployer, dead, "40"), t("0xa2", "0xpool", deployer, "40"), t("0xother", deployer, dead, "9", "0xanothertoken"), t("0xb1", deployer, dead, "25"), t("0xgift", deployer, "0xfriend", "5"), t("0xa1", "0xpool", deployer, "30")] },
        }),
      },
    } as unknown as SpliceData;
    const h = (await burnHistory(data)) as { deployer: string; burns: Array<{ txHash: string; amount: string; acquiredInTx: string | null }> };
    assert.equal(h.deployer, deployer);
    assert.deepEqual(h.burns.map((b) => [b.txHash, b.amount, b.acquiredInTx]), [["0xb2", "40", "0xa2"], ["0xb1", "25", null]]);
  });
});
