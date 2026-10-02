import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "..", "manifest.json"), "utf8"));

describe("@splice/robinhood", () => {
  it("declares only host capabilities (no files, network or env)", () => {
    assert.deepEqual(manifest.permissions.fs, { read: [], write: [] });
    assert.deepEqual(manifest.permissions.network, []);
    assert.deepEqual(manifest.permissions.env, []);
    assert.ok(manifest.permissions.capabilities.length >= 9);
  });

  it("each tool forwards its input to exactly one capability", async () => {
    const expected = {"trending":"tokens.rank","rank":"tokens.rank","token":"tokens.details","report":"tokens.report","whales":"tokens.whales","stock":"stock.quote","perps":"perps.markets","funding":"perps.funding","defi":"defi.overview","markets":"global.overview"};
    for (const tool of manifest.tools) {
      const calls: Array<{ name: string; args: unknown }> = [];
      const mod = await import(join(here, "..", tool.entry).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
      const result = await mod.default({ token: "PONS", symbol: "TSLA", kind: "gainers", limit: 3, unknown: "dropped" }, { capability: async (name: string, args: unknown) => (calls.push({ name, args }), { status: "LIVE", data: { ok: true } }) });
      assert.equal(result.status, "LIVE", tool.name);
      assert.equal(calls.length, 1, tool.name);
      assert.equal(calls[0]!.name, (expected as Record<string, string>)[tool.name], tool.name);
      assert.ok(!JSON.stringify(calls[0]!.args).includes("dropped"), "only declared keys are forwarded");
    }
  });

  it("trending always asks for kind=trending", async () => {
    const mod = await import("../tools/trending.ts");
    let seen: unknown;
    await mod.default({ limit: 5 }, { capability: async (_n: string, args: unknown) => ((seen = args), { status: "LIVE" }) });
    assert.deepEqual(seen, { limit: 5, kind: "trending" });
  });

  it("fails clearly without a capability-capable runtime", async () => {
    const mod = await import("../tools/report.ts");
    await assert.rejects(mod.default({ token: "PONS" }, {}), /does not provide host capabilities/);
  });
});
