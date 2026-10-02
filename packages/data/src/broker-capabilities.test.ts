import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BROKER_CAPABILITIES } from "@spliceloom/spec";
import { BROKER, createCapabilityBroker } from "./broker.js";
import type { SpliceData } from "./services.js";

describe("capability broker: market, research and global capabilities", () => {
  it("has an entry for every capability in the spec", () => {
    for (const c of BROKER_CAPABILITIES) assert.ok(BROKER[c], c);
    for (const c of ["tokens.rank", "tokens.report", "stock.quote", "perps.markets", "defi.overview", "global.overview", "macro.overview", "equity.profile"]) assert.ok((BROKER_CAPABILITIES as readonly string[]).includes(c), c);
  });

  it("validates arguments before calling the data layer", async () => {
    let called = false;
    const broker = createCapabilityBroker({ tokens: { rank: async () => ((called = true), { status: "LIVE" }) } } as unknown as SpliceData);
    const bad = (await broker.call({ package: "@splice/robinhood", tool: "t", capability: "tokens.rank", args: { kind: "everything" } })) as { status: string; code: string };
    assert.equal(bad.status, "ERROR");
    assert.equal(bad.code, "INVALID_INPUT");
    assert.equal(called, false);
    const ok = (await broker.call({ package: "@splice/robinhood", tool: "t", capability: "tokens.rank", args: { kind: "gainers", limit: 5 } })) as { status: string };
    assert.equal(ok.status, "LIVE");
  });

  it("gives composite results an overall status for skills", async () => {
    const data = {
      stocks: { quote: async () => ({ kind: "composite", subject: "TSLA", sections: { robinhood: { status: "ERROR" }, dex: { status: "LIVE" } } }) },
      defi: { overview: async () => ({ kind: "composite", subject: "defi", sections: { tvl: { status: "UNAVAILABLE" } } }) },
    } as unknown as SpliceData;
    const broker = createCapabilityBroker(data);
    const quote = (await broker.call({ package: "@splice/robinhood", tool: "t", capability: "stock.quote", args: { symbol: "TSLA" } })) as { status: string; sections: Record<string, unknown> };
    assert.equal(quote.status, "LIVE");
    assert.ok(quote.sections.dex);
    const defi = (await broker.call({ package: "@splice/robinhood", tool: "t", capability: "defi.overview", args: {} })) as { status: string };
    assert.equal(defi.status, "UNAVAILABLE");
  });
});
