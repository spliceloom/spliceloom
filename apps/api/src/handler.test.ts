import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpliceData } from "@spliceloom/data";
import { MAX_QUESTION, createApiHandler, formatUnits, type Counters } from "./handler.js";

const ORIGIN = "https://spliceloom.com";
const noData = (): SpliceData => {
  throw new Error("data must not be used");
};
const memoryCounters = (): Counters & { values: Map<string, number> } => {
  const values = new Map<string, number>();
  return { values, increment: async (key) => values.set(key, (values.get(key) ?? 0) + 1).get(key)! };
};
const ask = (body: unknown, origin: string | null = ORIGIN) =>
  new Request("https://api.spliceloom.com/v1/ask", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

describe("formatUnits", () => {
  it("formats integer amounts without float rounding", () => {
    assert.equal(formatUnits(29088733179350257117689598n, 18), "29088733.179350257117689598");
    assert.equal(formatUnits(1000000000000000000000000000n, 18), "1000000000");
    assert.equal(formatUnits(0n, 18), "0");
  });
});

describe("api handler", () => {
  it("answers health and 404 with CORS only for allowed origins", async () => {
    const handle = createApiHandler({ data: noData, origins: [ORIGIN] });
    const ok = await handle(new Request("https://api.spliceloom.com/v1/health", { headers: { origin: ORIGIN } }), "1.2.3.4");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    const other = await handle(new Request("https://api.spliceloom.com/v1/health", { headers: { origin: "https://evil.example" } }), "1.2.3.4");
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    assert.equal((await handle(new Request("https://api.spliceloom.com/nope"), "1.2.3.4")).status, 404);
  });

  it("allows preflight only from allowed origins", async () => {
    const handle = createApiHandler({ data: noData, origins: [ORIGIN] });
    const pre = (origin: string) => handle(new Request("https://api.spliceloom.com/v1/ask", { method: "OPTIONS", headers: { origin } }), "c");
    assert.equal((await pre(ORIGIN)).status, 204);
    assert.equal((await pre("https://evil.example")).status, 403);
  });

  it("validates Ask input before any data or model call", async () => {
    const handle = createApiHandler({ data: noData, origins: [ORIGIN] });
    assert.equal((await handle(ask({ question: "tvl?" }, null), "c")).status, 403);
    assert.equal((await handle(ask({ question: "tvl?" }, "https://evil.example"), "c")).status, 403);
    assert.equal((await handle(ask({}), "c")).status, 400);
    assert.equal((await handle(ask({ question: "x".repeat(MAX_QUESTION + 1) }), "c")).status, 400);
    assert.equal((await handle(new Request("https://api.spliceloom.com/v1/ask", { headers: { origin: ORIGIN } }), "c")).status, 405);
  });

  it("enforces the burst, per-client and global daily limits", async () => {
    const burstDenied = createApiHandler({ data: noData, origins: [ORIGIN], burst: async () => false });
    assert.equal((await burstDenied(ask({ question: "tvl?" }), "c")).status, 429);

    const counters = memoryCounters();
    const now = () => new Date("2026-10-03T12:00:00Z");
    const perClient = createApiHandler({ data: noData, origins: [ORIGIN], counters, askPerClientDaily: 0, now });
    const r = await perClient(ask({ question: "tvl?" }), "1.2.3.4");
    assert.equal(r.status, 429);
    assert.match(((await r.json()) as { message: string }).message, /Daily question limit/);
    // Client keys are hashed, never stored raw.
    assert.ok([...counters.values.keys()].every((k) => !k.includes("1.2.3.4")));

    const global = createApiHandler({ data: noData, origins: [ORIGIN], counters: memoryCounters(), askPerClientDaily: 5, askDailyLimit: 0, now });
    assert.equal((await global(ask({ question: "tvl?" }), "c")).status, 429);
  });
});
