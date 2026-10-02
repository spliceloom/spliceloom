import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { isLive } from "./result.js";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const row = (symbol: string, address: string, liquidity: string, change24: string) => ({ priceUSD: "1.5", change1: "0.01", change4: "-0.02", change12: null, change24, volume1: "100", volume24: "50000", liquidity, marketCap: "1000000", holders: 42, txnCount24: 10, buyCount24: 6, sellCount24: 4, uniqueBuys24: 3, uniqueSells24: 2, createdAt: 1_790_000_000, isScam: null, token: { address, name: symbol, symbol, info: { imageThumbUrl: "https://x.test/i.png" } } });

function fakeCodex(seen: Array<{ query: string; variables: any; auth: string }>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.startsWith("https://graph.codex.io/graphql")) return new Response("not mocked", { status: 500 });
    const body = JSON.parse(String(init?.body));
    seen.push({ query: body.query, variables: body.variables, auth: (init?.headers as Record<string, string>).authorization ?? "" });
    if (body.query.includes("filterTokens")) {
      if (body.variables.p === "nvda") return Response.json({ data: { filterTokens: { results: [row("NVDA", NVDA, "2000000", "0.011"), row("NVDAX", "0x1111111111111111111111111111111111111111", "5000", "0.5")] } } });
      return Response.json({ data: { filterTokens: { results: [row("MOON", "0x2222222222222222222222222222222222222222", "250000", "3.215"), row("DUST", "0x3333333333333333333333333333333333333333", "16", "9.9")] } } });
    }
    if (body.query.includes("holders")) return Response.json({ errors: [{ message: "Not authorized: please upgrade your plan", extensions: { code: "NOT_AUTHORIZED" } }], data: null });
    if (body.query.includes("getTokenPrices")) return Response.json({ data: { getTokenPrices: [{ address: NVDA, priceUsd: 234.68, timestamp: 1_790_967_560 }] } });
    if (body.query.includes("getBars")) return Response.json({ data: { getBars: { t: [1, 2], o: [1, 2], h: [2, 3], l: [0.5, 1.5], c: [1.5, 2.5], volume: ["10", "20"] } } });
    if (body.query.includes("getTokenEvents")) return Response.json({ data: { getTokenEvents: { items: [{ eventDisplayType: "Buy", timestamp: 1_790_967_511, transactionHash: "0xabc", maker: "0xdef", data: { priceUsd: "234.77", priceUsdTotal: "1324.32" } }] } } });
    if (body.query.includes("token(input")) return Response.json({ data: { token: { address: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA", decimals: 18, totalSupply: "74610", createdAt: 1_781_031_216, info: { description: "" }, socialLinks: { website: "https://robinhood.com" } } } });
    if (body.query.includes("listPairsWithMetadataForToken")) return Response.json({ data: { listPairsWithMetadataForToken: { results: [{ volume: "12366806", liquidity: "2124231", pair: { address: "0xd4eb" }, exchange: { name: "Uniswap" } }] } } });
    return Response.json({ errors: [{ message: "unexpected query" }] });
  };
}

describe("Codex (every Robinhood Chain token)", () => {
  const make = (seen: Array<{ query: string; variables: any; auth: string }>, env: Record<string, string> = { CODEX_API_KEY: "codex-key" }) => new SpliceData({ env, envFile: null, fetch: fakeCodex(seen) });

  it("ranks tokens server-side on network 4663 with scam and liquidity filters, converting fractions to percent", async () => {
    const seen: Array<{ query: string; variables: any; auth: string }> = [];
    const r = await make(seen).tokens.rank("gainers", { window: "h4" });
    assert.ok(isLive(r), JSON.stringify(r));
    const sent = seen[0]!;
    assert.equal(sent.auth, "codex-key");
    assert.deepEqual(sent.variables.f.network, [4663]);
    assert.equal(sent.variables.f.potentialScam, false);
    assert.deepEqual(sent.variables.f.liquidity, { gt: 10_000 });
    assert.deepEqual(sent.variables.r, [{ attribute: "change4", direction: "DESC" }]);
    assert.deepEqual(r.data.tokens.map((t) => t.symbol), ["MOON"], "row liquidity re-checked (DUST has $16)");
    assert.equal(r.data.tokens[0]!.changePct.h24, 321.5);
    assert.equal(r.data.tokens[0]!.changePct.h12, undefined, "a null change stays absent");
    assert.match(r.data.filters!, /largest price increase over h4/);
    const trending = await make(seen).tokens.rank("trending");
    assert.ok(isLive(trending));
    assert.equal(seen.at(-1)!.variables.f.trendingIgnored, false);
  });

  it("resolves symbols, and details gathers info, pairs, trades and chart", async () => {
    const seen: Array<{ query: string; variables: any; auth: string }> = [];
    const d = make(seen);
    const details = await d.tokens.details("nvda");
    assert.ok("sections" in details, JSON.stringify(details));
    assert.equal(details.subject, NVDA);
    for (const k of ["info", "pairs", "trades", "chart", "stats"]) assert.equal(details.sections[k]!.status, "LIVE", k);
    const trades = details.sections.trades as { data: { trades: Array<{ type: string; valueUsd: string }> } };
    assert.deepEqual(trades.data.trades.map((t) => [t.type, t.valueUsd]), [["Buy", "1324.32"]]);
    const chart = details.sections.chart as { data: { candles: Array<{ close: string; volumeUsd: string }> } };
    assert.deepEqual(chart.data.candles.map((c) => [c.close, c.volumeUsd]), [["1.5", "10"], ["2.5", "20"]]);
    const missing = await d.tokens.resolve("ZZZZ");
    assert.ok("status" in missing && missing.status === "UNAVAILABLE");
  });

  it("is not configured without CODEX_API_KEY and validates input before any request", async () => {
    const seen: Array<{ query: string; variables: any; auth: string }> = [];
    const d = make(seen, {});
    assert.equal((await d.tokens.rank("trending")).status, "UNAVAILABLE");
    assert.equal((await d.tokens.rank("nope" as "trending")).status, "ERROR");
    assert.equal((await d.tokens.chart("0x12", { timeframe: "1h" })).status, "ERROR");
    assert.equal(seen.length, 0);
  });
});
