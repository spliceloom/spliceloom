import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { isLive } from "./result.js";

function fake(seen: Array<{ url: string; headers: Record<string, string> }>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("finnhub.io/api/v1/quote")) return Response.json({ c: 233.86, d: 3, dp: 1.2995, h: 237.88, l: 233.78, o: 234.06, pc: 230.86, t: 1_790_969_309 });
    if (url.includes("finnhub.io/api/v1/stock/price-target")) return Response.json({ error: "You don't have access to this resource." }, { status: 403 });
    if (url.includes("finnhub.io/api/v1/stock/market-status")) return Response.json({ exchange: "US", holiday: null, isOpen: true, session: "regular", t: 1_790_969_319, timezone: "America/New_York" });
    if (url.includes("api.stlouisfed.org/fred/series/observations") && url.includes("CPIAUCSL"))
      return Response.json({ observations: Array.from({ length: 14 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, "0")}-01`, value: String(300 + i) })).reverse() });
    if (url.includes("api.stlouisfed.org/fred/series/observations")) return Response.json({ observations: [{ date: "2026-09-30", value: "3.88" }, { date: "2026-09-29", value: "." }, { date: "2026-09-26", value: "3.90" }] });
    if (url.includes("api.stlouisfed.org/fred/series?")) return Response.json({ seriess: [{ title: "Federal Funds Effective Rate", units_short: "%", frequency_short: "D" }] });
    if (url.includes("api.rh.lighter.xyz/api/v1/orderBookDetails"))
      return Response.json({
        order_book_details: [
          { symbol: "BTC", status: "active", mark_price: "84108.1", index_price: "84134.5", last_trade_price: 84100, daily_price_change: -0.55, daily_quote_token_volume: 132703799.2, daily_trades_count: 151065, open_interest: 294.7, default_initial_margin_fraction: 5000 },
          { symbol: "SPY", status: "active", mark_price: "770.06", daily_price_change: 0.66, daily_quote_token_volume: 79589217, open_interest: 63240, default_initial_margin_fraction: 5000 },
          { symbol: "OLD", status: "inactive", mark_price: "1", daily_quote_token_volume: 1e12 },
        ],
        spot_order_book_details: [{ symbol: "AAPL-USDG", status: "active", last_trade_price: 333.4, daily_quote_token_volume: 50000 }],
      });
    if (url.includes("api.rh.lighter.xyz/api/v1/funding-rates"))
      return Response.json({ funding_rates: [{ exchange: "lighter", symbol: "BTC", rate: 0.0001 }, { exchange: "binance", symbol: "BTC", rate: 0.00005 }, { exchange: "binance", symbol: "ONLYCEX", rate: 0.001 }, { exchange: "lighter", symbol: "SPY", rate: -0.0003 }] });
    return new Response("not mocked", { status: 500 });
  };
}

describe("Finnhub, FRED and Lighter", () => {
  const env = { FINNHUB_API_KEY: "fh-key", FRED_API_KEY: "fred-key" };

  it("Finnhub quote with the key in a header; plan-gated endpoints are 'not in this plan'", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const d = new SpliceData({ env, envFile: null, fetch: fake(seen) });
    const q = await d.equities.quote("nvda");
    assert.ok(isLive(q), JSON.stringify(q));
    assert.equal((q.data as { priceUsd: number }).priceUsd, 233.86);
    assert.equal(seen[0]!.headers["x-finnhub-token"], "fh-key");
    assert.ok(!seen[0]!.url.includes("fh-key"), "the key is not in the URL");
    const status = await d.equities.marketStatus();
    assert.ok(isLive(status));
    assert.equal((status.data as { session: string }).session, "regular");
    assert.equal((await d.equities.quote("not a ticker!")).status, "ERROR");
  });

  it("FRED skips missing values and computes CPI year-over-year in the overview", async () => {
    const d = new SpliceData({ env, envFile: null, fetch: fake([]) });
    const s = await d.macro.series("dff", { limit: 5 });
    assert.ok(isLive(s));
    assert.deepEqual((s.data as { points: Array<{ value: number }> }).points.map((p) => p.value), [3.9, 3.88]);
    const o = await d.macro.overview();
    assert.ok(isLive(o), JSON.stringify(o));
    const cpi = o.data.series.find((x) => x.id === "CPIAUCSL")!;
    assert.equal(cpi.value, 3.99); // 313 vs 301, 12 months earlier
    assert.doesNotMatch(JSON.stringify(o), /fred-key/);
  });

  it("Lighter (Robinhood deployment): perps sorted by volume, open interest in USD, inactive markets dropped, funding per exchange", async () => {
    const d = new SpliceData({ env: {}, envFile: null, fetch: fake([]) });
    const m = await d.perps.markets();
    assert.ok(isLive(m), JSON.stringify(m));
    assert.deepEqual(m.data.markets.map((x) => x.symbol), ["BTC", "SPY"]);
    assert.equal(m.data.markets[0]!.openInterestUsd, Math.round(294.7 * 84108.1));
    assert.equal(m.data.markets[0]!.initialMarginPct, 50);
    const spot = await d.perps.markets({ type: "spot" });
    assert.ok(isLive(spot) && spot.data.markets[0]!.symbol === "AAPL-USDG");
    const f = await d.perps.funding();
    assert.ok(isLive(f));
    assert.deepEqual(f.data.rates, [{ symbol: "SPY", percentPerInterval: { lighter: -0.03 } }, { symbol: "BTC", percentPerInterval: { lighter: 0.01, binance: 0.005 } }]);
    assert.equal((await d.perps.markets({ venue: "nope" })).status, "ERROR");
  });
});
