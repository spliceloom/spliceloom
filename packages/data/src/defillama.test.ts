import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { isLive } from "./result.js";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const day = (n: number) => 1_790_000_000 + n * 86_400;

function fakeLlama(seen: string[]) {
  return async (url: string): Promise<Response> => {
    seen.push(url);
    if (url.includes("/v2/historicalChainTvl/Robinhood%20Chain")) return Response.json(Array.from({ length: 31 }, (_, i) => ({ date: day(i), tvl: 1_000_000 + i * 10_000 })));
    if (url.endsWith("/protocols"))
      return Response.json([
        { name: "Morpho Blue", slug: "morpho-blue", category: "Lending", tvl: 11e9, change_1d: 0.8, chainTvls: { "Robinhood Chain": 588e6, Ethereum: 5e9 }, chains: ["Ethereum", "Robinhood Chain"] },
        { name: "Elsewhere", slug: "elsewhere", category: "Dexs", tvl: 1e9, chainTvls: { Ethereum: 1e9 } },
        { name: "Uniswap V4", slug: "uniswap-v4", category: "Dexs", tvl: 1.27e9, chainTvls: { "Robinhood Chain": 187e6 } },
      ]);
    if (url.includes("/overview/dexs/Robinhood%20Chain")) return Response.json({ total24h: 1.53e9, total7d: 9.4e9, change_1d: 1.6, protocols: [{ name: "Uniswap V4", total24h: 5e8 }, { displayName: "Uniswap V3", name: "uniswap-v3", total24h: 5.7e8, change_1d: 2.4 }, { name: "Silent", total24h: null }] });
    if (url.includes("/stablecoincharts/Robinhood%20Chain")) return Response.json(Array.from({ length: 8 }, (_, i) => ({ date: String(day(i)), totalCirculatingUSD: { peggedUSD: 1e9 + i * 1e6 }, totalMintedUSD: { peggedUSD: 7e8 }, totalBridgedToUSD: { peggedUSD: 3e8 } })));
    if (url.includes("yields.llama.fi/pools")) return Response.json({ data: [{ chain: "Robinhood Chain", project: "morpho-blue", symbol: "STEAKUSDG", tvlUsd: 5.2e8, apy: 7.01 }, { chain: "Robinhood Chain", project: "tiny", symbol: "X", tvlUsd: 50, apy: 900 }, { chain: "Ethereum", project: "aave", symbol: "USDC", tvlUsd: 1e9, apy: 4 }, { chain: "Robinhood Chain", project: "midas-rwa", symbol: "USDC", tvlUsd: 3.6e7, apy: 6.2 }] });
    if (url.includes("coins.llama.fi/prices/current/")) return Response.json({ coins: { [`robinhood:${NVDA}`]: { symbol: "NVDA", price: 234.44, confidence: 0.995, timestamp: 1_790_966_076 } } });
    return new Response("not mocked", { status: 500 });
  };
}

describe("DefiLlama (Robinhood Chain)", () => {
  const make = (seen: string[]) => new SpliceData({ env: {}, envFile: null, fetch: fakeLlama(seen) });

  it("chain TVL with changes from the daily history; protocols ranked by TVL on the chain", async () => {
    const d = make([]);
    const tvl = await d.defi.tvl();
    assert.ok(isLive(tvl), JSON.stringify(tvl));
    assert.equal((tvl.data as { tvlUsd: number }).tvlUsd, 1_300_000);
    assert.equal((tvl.data as { change1dPct: number }).change1dPct, 0.78);
    const protocols = await d.defi.protocols();
    assert.ok(isLive(protocols));
    assert.deepEqual(
      protocols.data.protocols.map((p) => [p.name, (p as { tvlOnChainUsd?: number }).tvlOnChainUsd]),
      [
        ["Morpho Blue", 588e6],
        ["Uniswap V4", 187e6],
      ],
    );
  });

  it("overview sections, DEX volume sorted, yields filtered and sorted, prices from the coins API", async () => {
    const seen: string[] = [];
    const d = make(seen);
    const overview = await d.defi.overview();
    assert.ok("sections" in overview);
    assert.deepEqual(Object.keys(overview.sections).sort(), ["dexVolume", "fees", "stablecoins", "tvl"]);
    const dex = await d.defi.dexes();
    assert.ok(isLive(dex));
    assert.deepEqual((dex.data as { protocols: Array<{ name: string }> }).protocols.map((p) => p.name), ["Uniswap V3", "Uniswap V4"]);
    const yields = await d.defi.yields({ sort: "apy" });
    assert.ok(isLive(yields));
    assert.deepEqual(yields.data.pools.map((p) => p.project), ["morpho-blue", "midas-rwa"], "small pools and other chains dropped");
    const price = await d.defi.tokenPrice(NVDA);
    assert.ok(isLive(price));
    assert.deepEqual((price.data as { prices: unknown[] }).prices, [{ address: NVDA, symbol: "NVDA", priceUsd: "234.44", confidence: 0.995, time: new Date(1_790_966_076_000).toISOString() }]);
    assert.ok(seen.some((u) => u.includes(`/prices/current/robinhood:${NVDA}`)));
    assert.equal((await d.defi.tokenPrice("0x123")).status, "ERROR");
  });
});
