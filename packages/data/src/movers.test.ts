import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { isLive } from "./result.js";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

interface PoolSpec {
  address: string;
  symbol: string;
  token: string;
  liquidity: number;
  change: { h1: number; h6: number; h24: number };
  volume: { h1: number; h6: number; h24: number };
  ageHours: number;
}

function pool(p: PoolSpec) {
  return {
    id: `robinhood_${p.address}`,
    type: "pool",
    attributes: {
      address: p.address,
      name: `${p.symbol} / WETH`,
      base_token_price_usd: "1.5",
      reserve_in_usd: String(p.liquidity),
      price_change_percentage: { h1: String(p.change.h1), h6: String(p.change.h6), h24: String(p.change.h24) },
      volume_usd: { h1: String(p.volume.h1), h6: String(p.volume.h6), h24: String(p.volume.h24) },
      transactions: { h24: { buys: 10, sells: 5 } },
      pool_created_at: hoursAgo(p.ageHours),
    },
    relationships: { base_token: { data: { id: `robinhood_${p.token}` } }, quote_token: { data: { id: `robinhood_${WETH}` } }, dex: { data: { id: "uniswap-v4-robinhood" } } },
  };
}

function listing(specs: PoolSpec[]) {
  return {
    data: specs.map(pool),
    included: [
      ...specs.map((s) => ({ id: `robinhood_${s.token}`, type: "token", attributes: { address: s.token, symbol: s.symbol, name: s.symbol } })),
      { id: `robinhood_${WETH}`, type: "token", attributes: { address: WETH, symbol: "WETH", name: "Wrapped Ether" } },
    ],
  };
}

const flat = { h1: 0, h6: 0, h24: 0 };
const POOLS: PoolSpec[] = [
  { address: "0x01", symbol: "MOON", token: "0xa1", liquidity: 200_000, change: { h1: 5, h6: 40, h24: 300 }, volume: { h1: 50_000, h6: 300_000, h24: 900_000 }, ageHours: 48 },
  { address: "0x02", symbol: "DUMP", token: "0xa2", liquidity: 80_000, change: { h1: -3, h6: -20, h24: -60 }, volume: { h1: 100, h6: 2_000, h24: 400_000 }, ageHours: 72 },
  { address: "0x03", symbol: "THIN", token: "0xa3", liquidity: 900, change: { h1: 0, h6: 0, h24: 5000 }, volume: { h1: 10, h6: 50, h24: 2_000 }, ageHours: 5 },
  { address: "0x04", symbol: "USDG", token: "0xa4", liquidity: 5_000_000, change: { h1: 0, h6: 0, h24: 0.1 }, volume: { h1: 1e6, h6: 6e6, h24: 2e7 }, ageHours: 900 },
  { address: "0x05", symbol: "MOON", token: "0xa1", liquidity: 20_000, change: { h1: 1, h6: 1, h24: 10 }, volume: { h1: 1, h6: 1, h24: 100 }, ageHours: 48 },
  { address: "0x06", symbol: "TSLA", token: TSLA, liquidity: 50_000, change: { h1: 0.2, h6: 0.5, h24: 2.5 }, volume: { h1: 2_000, h6: 20_000, h24: 100_000 }, ageHours: 2000 },
  { address: "0x07", symbol: "FLAT", token: "0xa7", liquidity: 30_000, change: flat, volume: { h1: 30_000, h6: 40_000, h24: 60_000 }, ageHours: 100 },
];

function fakeFetch(seen: string[]) {
  return async (url: string): Promise<Response> => {
    seen.push(url);
    if (url.includes("/onchain/networks/robinhood/pools?sort=h24_volume_usd_desc&page=1")) return Response.json(listing(POOLS));
    if (url.includes("/onchain/networks/robinhood/pools")) return Response.json({ data: [], included: [] });
    if (url.includes("/onchain/networks/robinhood/trending_pools")) return Response.json(listing([]));
    if (url.includes("/coins/list")) return Response.json([{ id: "tesla-robinhood-tokenized-stock", symbol: "tsla", name: "Tesla • Robinhood Token", platforms: { robinhood: TSLA } }, { id: "bitcoin", symbol: "btc", name: "Bitcoin", platforms: {} }]);
    if (url.includes("api.robinhood.com")) throw new TypeError("fetch failed");
    return new Response("not mocked", { status: 500 });
  };
}

describe("market movers (computed from provider fields)", () => {
  const data = (seen: string[]) => new SpliceData({ env: { COINGECKO_API_KEY: "demo-key" }, envFile: null, fetch: fakeFetch(seen) });

  it("ranks gainers and losers, dropping thin pools, stablecoin bases and duplicate tokens", async () => {
    const seen: string[] = [];
    const d = data(seen);
    const gainers = await d.market.movers("robinhood", { kind: "gainers" });
    assert.ok(isLive(gainers), JSON.stringify(gainers));
    assert.deepEqual(gainers.data.pools.map((p) => p.baseToken?.symbol), ["MOON", "TSLA"]);
    assert.equal(gainers.data.pools[0]!.pairAddress, "0x01", "deepest MOON pool kept");
    assert.equal(gainers.data.pools[0]!.metric.value, 300);
    assert.equal(gainers.provenance.source, "coingecko");
    assert.match(gainers.data.formula, /liquidity ≥ \$10,000/);
    assert.ok(seen.some((u) => u.includes("trending_pools?") && u.includes("duration=24h")));
    const losers = await d.market.movers("robinhood", { kind: "losers", window: "h6" });
    assert.ok(isLive(losers));
    assert.deepEqual(losers.data.pools.map((p) => p.baseToken?.symbol), ["DUMP"]);
    const low = await d.market.movers("robinhood", { kind: "gainers", minLiquidity: 0 });
    assert.ok(isLive(low) && low.data.pools.some((p) => p.baseToken?.symbol === "THIN"));
  });

  it("volume-drop uses the 6h pace (volume_h6 × 4 ÷ volume_h24) and volume-up the 1h pace", async () => {
    const d = data([]);
    const drop = await d.market.movers("robinhood", { kind: "volume-drop" });
    assert.ok(isLive(drop));
    assert.equal(drop.data.pools[0]!.baseToken?.symbol, "DUMP");
    assert.equal(drop.data.pools[0]!.metric.value, 0.02); // 2000 × 4 / 400000
    const up = await d.market.movers("robinhood", { kind: "volume-up" });
    assert.ok(isLive(up));
    assert.equal(up.data.pools[0]!.baseToken?.symbol, "FLAT"); // 30000 × 24 / 60000 = 12
    assert.equal(up.data.pools[0]!.metric.value, 12);
  });

  it("validates options before any request", async () => {
    const seen: string[] = [];
    const d = data(seen);
    assert.equal((await d.market.movers("robinhood", { kind: "nope" as "gainers" })).status, "ERROR");
    assert.equal((await d.market.topPools("robinhood", { page: 11 })).status, "ERROR");
    assert.equal(seen.length, 0);
  });

  it("stock tokens fall back from Robinhood's API to CoinGecko, and stock movers keep stock pools only", async () => {
    const d = data([]);
    const list = await d.stocks.tokens();
    assert.ok(isLive(list), JSON.stringify(list));
    assert.equal(list.provenance.source, "coingecko");
    assert.deepEqual(list.data.tokens, [{ symbol: "TSLA", name: "Tesla • Robinhood Token", address: TSLA, coingeckoId: "tesla-robinhood-tokenized-stock" }]);
    assert.ok(list.provenance.fallbackFrom?.some((f) => f.provider === "robinhood-stock-api"));
    const movers = await d.stocks.movers({ kind: "gainers" });
    assert.ok(isLive(movers));
    assert.deepEqual(movers.data.pools.map((p) => p.baseToken?.symbol), ["TSLA"]);
  });
});
