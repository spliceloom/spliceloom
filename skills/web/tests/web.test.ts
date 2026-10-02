/**
 * Unit tests for @splice/web with a stub capability function (no provider calls).
 * The sandbox/broker path with real providers is covered by the Splice repository's tests.
 * Run with: node --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import answer from "../tools/answer.ts";
import read from "../tools/read.ts";
import search from "../tools/search.ts";

function ctx(result: unknown = { status: "LIVE", data: {}, provenance: { source: "stub" } }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return { calls, ctx: { capability: async (name: string, args?: unknown) => (calls.push({ name, args }), result) } };
}

describe("@splice/web", () => {
  it("maps tools to host capabilities with only the given arguments", async () => {
    const s = ctx();
    await search({ query: "robinhood chain", limit: 3 }, s.ctx);
    await read({ urls: ["https://docs.robinhood.com/chain/"] }, s.ctx);
    await answer({ question: "chain id?" }, s.ctx);
    assert.deepEqual(s.calls, [
      { name: "web.search", args: { query: "robinhood chain", limit: 3 } },
      { name: "web.extract", args: { urls: ["https://docs.robinhood.com/chain/"] } },
      { name: "web.answer", args: { query: "chain id?" } },
    ]);
  });

  it("returns the host result unchanged (including UNAVAILABLE)", async () => {
    const unavailable = { status: "UNAVAILABLE", code: "CAPABILITY_UNAVAILABLE", reason: "no provider" };
    assert.deepEqual(await search({ query: "x" }, ctx(unavailable).ctx), unavailable);
  });

  it("fails clearly on a runtime without host capabilities", async () => {
    await assert.rejects(search({ query: "x" }, {}), /does not provide host capabilities/);
  });
});
