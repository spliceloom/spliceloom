/**
 * Live test of the capability broker: the official broker skills (@splice/web, @splice/market,
 * @splice/onchain) run in the real sandbox and reach real providers only through the host broker
 * (the host's keys from .env.local; the skills get none). Inputs are discovered live (a Robinhood
 * pair from DexScreener search, an address from a recent transaction). Spends a few web credits.
 *
 *   npm run test:live
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceProject, packDirectory } from "../../packages/core/dist/index.js";
import { isLive, loadProviderEnv } from "../../packages/data/dist/index.js";
import { Splice } from "../../packages/sdk/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = loadProviderEnv({ cwd: ROOT });
const summary: string[] = [];
const outputs: unknown[] = [];

describe("capability broker (live)", { timeout: 300_000 }, () => {
  let root: string;
  let splice: Splice;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-broker-live-"));
    const project = (await SpliceProject.init(join(root, "project"))).project;
    const packages: Record<string, unknown> = {};
    for (const name of ["web", "market", "onchain"]) {
      const src = join(ROOT, "skills", name);
      const packed = await packDirectory(src);
      cpSync(src, project.packageDir(`@splice/${name}`), { recursive: true });
      packages[`@splice/${name}`] = { version: packed.manifest.version, integrity: packed.integrity, registry: "file:", resolved: "file:", permissions: packed.manifest.permissions };
    }
    await project.writeLock({ lockfileVersion: 1, packages: packages as never });
    // Tools get no environment at all; the host data layer reads the provider keys from the repository's .env.local.
    splice = new Splice({ project: project.root, env: {}, data: { cwd: ROOT } });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    const text = JSON.stringify(outputs);
    for (const secret of env.secrets) assert.ok(!text.includes(secret), "a provider key reached a skill output");
    console.log(`\nLIVE SUMMARY (capability broker)\n${summary.map((s) => `  ${s}`).join("\n")}\n`);
  });

  const run = async (ref: string, input: unknown) => {
    const r = await splice.run(ref, input);
    outputs.push(r);
    assert.ok(r.ok, `${ref}: ${JSON.stringify(r)}`);
    const out = r.output as any;
    return out;
  };

  it("@splice/web: search and answer through the broker", async () => {
    const s = await run("web.search", { query: "Robinhood Chain documentation", limit: 2 });
    assert.ok(isLive(s), JSON.stringify(s));
    const a = await run("web.answer", { question: "What is the chain ID of Robinhood Chain mainnet?" });
    assert.ok(isLive(a) && /4663/.test(a.data.answer), JSON.stringify(a));
    summary.push(`web.search → ${s.status} via ${s.provenance.source} (${s.data.results.length} results); web.answer → "${a.data.answer.slice(0, 70)}" via ${a.provenance.source}`);
  });

  it("@splice/market: ETH price and Robinhood pairs through the broker", async () => {
    const p = await run("market.price", { token: "ETH" });
    assert.ok(isLive(p) && Number(p.data.price) > 0, JSON.stringify(p));
    const search = await splice.data.market.search("robinhood");
    assert.ok(isLive(search));
    const pair = (search.data as { pairs: Array<{ network: string; baseToken?: { address?: string } }> }).pairs.find((x) => x.network === "robinhood" && x.baseToken?.address);
    assert.ok(pair, "a Robinhood pair discovered live");
    const pairs = await run("market.pairs", { network: "robinhood", token: pair.baseToken!.address });
    assert.ok(isLive(pairs), JSON.stringify(pairs));
    summary.push(`market.price ETH → ${p.data.price} ${p.data.vs} via ${p.provenance.source}; market.pairs → ${pairs.data.pairs.length} pairs via ${pairs.provenance.source}`);
  });

  it("@splice/onchain: balance of an address from a recent transaction, pinned to a block", async () => {
    const latest = await splice.data.onchain.latestBlock({ fresh: true });
    assert.ok(isLive(latest));
    let from: string | undefined;
    for (const hash of latest.data.transactions.slice(0, 5)) {
      const tx = await splice.data.onchain.transaction(hash);
      if (isLive(tx) && tx.data.from && tx.data.from !== "0x00000000000000000000000000000000000a4b05") from = tx.data.from;
      if (from) break;
    }
    from ??= "0x00000000000000000000000000000000000a4b05";
    const b = await run("onchain.balance", { address: from });
    assert.ok(isLive(b) && /^\d+$/.test(b.data.wei) && b.provenance.chainId === 4663 && b.provenance.blockNumber, JSON.stringify(b));
    summary.push(`onchain.balance ${from} → ${b.data.formatted} ETH @ block ${b.provenance.blockNumber} via ${b.provenance.source}`);
  });
});
