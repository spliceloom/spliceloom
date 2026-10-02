/**
 * Unit tests for @splice/market with a stub capability function (no provider calls).
 * Run with: node --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import candles from "../tools/candles.ts";
import pairs from "../tools/pairs.ts";
import price from "../tools/price.ts";

function stub(result: unknown = { status: "LIVE", data: {}, provenance: { source: "stub" } }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return { calls, ctx: { capability: async (name: string, args?: unknown) => (calls.push({ name, args }), result) } };
}

describe("@splice/market", () => {
  it("maps tools to host capabilities", async () => {
    const s = stub();
    await price({ token: "ETH" }, s.ctx);
    await pairs({ network: "robinhood", token: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }, s.ctx);
    await candles({ network: "robinhood", pool: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca", timeframe: "hour", aggregate: 4, limit: 24 }, s.ctx);
    assert.deepEqual(s.calls, [
      { name: "market.price", args: { token: "ETH" } },
      { name: "market.pairs", args: { network: "robinhood", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" } },
      { name: "market.ohlcv", args: { network: "robinhood", pool: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca", timeframe: "hour", aggregate: 4, limit: 24 } },
    ]);
  });

  it("passes UNAVAILABLE through instead of a value", async () => {
    const r = { status: "UNAVAILABLE", code: "CAPABILITY_UNAVAILABLE", provider: "coingecko", reason: "no market listing" };
    assert.deepEqual(await price({ token: "0x0000000000000000000000000000000000000001" }, stub(r).ctx), r);
  });
});
