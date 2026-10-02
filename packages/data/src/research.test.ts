import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { isLive } from "./result.js";

const TOKEN = "0x2222222222222222222222222222222222222222";
const stats = { priceUSD: "0.01", change1: "0.1", change4: "0.2", change12: "0.3", change24: "2.5", volume24: "90000", liquidity: "4000", marketCap: "100000", holders: 40, txnCount24: 300, buyCount24: 50, sellCount24: 250, uniqueBuys24: 30, uniqueSells24: 60, createdAt: Math.floor(Date.now() / 1000) - 3 * 3600, isScam: false, token: { address: TOKEN, name: "Risky", symbol: "RISK" } };

function fake() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://graph.codex.io/graphql")) {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("filterTokens")) return Response.json({ data: { filterTokens: { results: [stats] } } });
      if (body.query.includes("listPairsWithMetadataForToken")) return Response.json({ data: { listPairsWithMetadataForToken: { results: [{ volume: "90000", liquidity: "4000", pair: { address: "0xpool" }, exchange: { name: "Uniswap" } }] } } });
      if (body.query.includes("getTokenEvents"))
        return Response.json({
          data: {
            getTokenEvents: {
              items: [
                { eventDisplayType: "Sell", timestamp: 1_790_967_600, transactionHash: "0x3", maker: "0xw1", data: { priceUsd: "0.01", priceUsdTotal: "12000" } },
                { eventDisplayType: "Buy", timestamp: 1_790_967_550, transactionHash: "0x2", maker: "0xw2", data: { priceUsd: "0.01", priceUsdTotal: "8000" } },
                { eventDisplayType: "Buy", timestamp: 1_790_967_500, transactionHash: "0x1", maker: "0xw2", data: { priceUsd: "0.01", priceUsdTotal: "200" } },
                { eventDisplayType: "Mint", timestamp: 1_790_967_400, transactionHash: "0x0", maker: "0xlp", data: {} },
              ],
            },
          },
        });
    }
    if (url.includes("api.gopluslabs.io/api/v1/token_security/4663"))
      return Response.json({ code: 1, result: { [TOKEN]: { is_honeypot: "0", buy_tax: "0.05", sell_tax: "0.25", is_mintable: "1", hidden_owner: "0", is_open_source: "1", holders: [{ address: "0xa", percent: "0.4" }, { address: "0xb", percent: "0.2" }], lp_holders: [{ address: "0xdead", percent: "0.9", is_locked: 1 }] } } });
    if (url.includes("api.blockscout.com/4663/api/v2/smart-contracts/")) return Response.json({ is_verified: true, name: "RiskyToken" });
    return new Response(JSON.stringify({ message: "not mocked" }), { status: 404 });
  };
}

describe("research report and whales", () => {
  const make = () => new SpliceData({ env: { CODEX_API_KEY: "k", BLOCKSCOUT_API_KEY: "b", ROBINHOOD_PUBLIC_RPC_URL: "off" }, envFile: null, fetch: fake() });

  it("derives flags from provider fields, each naming its source, dangers first", async () => {
    const r = await make().research.report("RISK");
    assert.ok("kind" in r && r.kind === "report", JSON.stringify(r));
    const texts = r.flags.map((f) => `${f.level}|${f.source}|${f.text}`);
    assert.ok(texts.some((t) => t.startsWith("danger|goplus sell_tax|sell tax 25.0%")), texts.join("\n"));
    assert.ok(texts.some((t) => t.startsWith("warn|goplus buy_tax|buy tax 5.0%")));
    assert.ok(texts.some((t) => t.startsWith("warn|goplus is_mintable")));
    assert.ok(texts.some((t) => t.startsWith("warn|codex liquidity|low liquidity: $4,000")));
    assert.ok(texts.some((t) => t.startsWith("warn|codex createdAt|new token: 3 hours old")));
    assert.ok(texts.some((t) => t.startsWith("warn|codex buy/sell counts|sell pressure")));
    assert.ok(texts.some((t) => t.startsWith("warn|goplus holders|top 2 holders own 60.0%")));
    assert.ok(texts.some((t) => t.startsWith("ok|goplus lp_holders|LP tokens locked: 90.0%")));
    assert.equal(r.flags[0]!.level, "danger");
    assert.equal(r.address, TOKEN);
  });

  it("whales keeps swaps at or above the threshold with totals and wallets", async () => {
    const w = await make().tokens.whales("RISK", { minUsd: 1000 });
    assert.ok(isLive(w), JSON.stringify(w));
    assert.equal(w.data.scanned, 3, "mints are not swaps");
    assert.equal(w.data.count, 2);
    assert.equal(w.data.buyUsd, 8000);
    assert.equal(w.data.sellUsd, 12000);
    assert.equal(w.data.netFlowUsd, -4000);
    assert.deepEqual(w.data.wallets.map((x) => x.wallet), ["0xw1", "0xw2"]);
  });
});
