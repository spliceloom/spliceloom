import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpliceData } from "@spliceloom/data";
import { MAX_QUESTION, cachedJson, createApiHandler, formatUnits, type Counters, type JsonCache } from "./handler.js";

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

describe("cachedJson (stale-while-revalidate, protects paid quotas)", () => {
  const memory = (): JsonCache & { rows: Map<string, { value: unknown; at: number }> } => {
    const rows = new Map<string, { value: unknown; at: number }>();
    return { rows, get: async (k) => rows.get(k) ?? null, set: async (k, value, at) => void rows.set(k, { value, at }) };
  };

  it("fetches once, serves fresh entries, and refreshes stale ones in the background", async () => {
    const cache = memory();
    let calls = 0;
    let clock = 1_000;
    const tasks: Promise<unknown>[] = [];
    const ctx = { cache, now: () => clock, background: (p: Promise<unknown>) => void tasks.push(p) };
    const fetch = async () => ({ n: ++calls });
    assert.deepEqual((await cachedJson(ctx, "k", 100, fetch, () => true)).value, { n: 1 });
    clock += 50;
    assert.deepEqual((await cachedJson(ctx, "k", 100, fetch, () => true)).value, { n: 1 }, "fresh: no provider call");
    clock += 100;
    assert.deepEqual((await cachedJson(ctx, "k", 100, fetch, () => true)).value, { n: 1 }, "stale: served immediately");
    await Promise.all(tasks);
    assert.equal(calls, 2, "refreshed once in the background");
    assert.deepEqual(cache.rows.get("k")!.value, { n: 2 });
  });

  it("waits for fresh data when an entry is too old, and keeps the old one if the refresh fails", async () => {
    const cache = memory();
    let clock = 0;
    await cache.set("k", { n: 1 }, 0);
    clock = 1_000;
    assert.deepEqual((await cachedJson({ cache, now: () => clock }, "k", 100, async () => ({ n: 2 }), () => true, 300)).value, { n: 2 });
    clock = 5_000;
    const failing = async (): Promise<{ n: number }> => {
      throw new Error("provider down");
    };
    assert.deepEqual((await cachedJson({ cache, now: () => clock }, "k", 100, failing, () => true, 300)).value, { n: 2 });
  });

  it("never caches values rejected by keep()", async () => {
    const cache = memory();
    await cachedJson({ cache }, "bad", 100, async () => ({ stats: null }), (v) => v.stats !== null);
    assert.equal(cache.rows.size, 0);
  });
});