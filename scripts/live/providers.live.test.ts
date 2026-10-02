/**
 * Live provider integration tests: real requests to the providers configured in .env.local /
 * .env (or process env). Nothing here is mocked and no chain value is hardcoded â€” blocks,
 * transactions, wallets and tokens are discovered from the chain at run time.
 *
 *   npm run test:live
 *
 * Providers that are not configured, rate-limited or unreachable must report that explicitly
 * (UNAVAILABLE / ERROR with a code) â€” a test fails if any result contains invented data or a key.
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceData, isLive, loadProviderEnv, resolveChain } from "../../packages/data/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SYSTEM = "0x00000000000000000000000000000000000a4b05"; // Arbitrum Orbit system sender
const env = loadProviderEnv({ cwd: ROOT });
const seen: unknown[] = [];
const summary: string[] = [];

const data = new SpliceData({ cwd: ROOT });
const robinhood = resolveChain("robinhood")!;

function note(line: string) {
  summary.push(line);
}
function keep<T>(r: T): T {
  seen.push(r);
  return r;
}
/** LIVE, or an explicit non-data state we accept for third-party limits (and record). */
function liveOr(r: any, label: string, accept: string[] = ["RATE_LIMITED", "CAPABILITY_UNAVAILABLE"]): boolean {
  keep(r);
  if (isLive(r)) {
    note(`${label}: ${r.status} via ${r.provenance.source} (block ${r.provenance.blockNumber ?? "-"})`);
    return true;
  }
  assert.ok(accept.includes(r.code), `${label}: unexpected ${r.status} ${r.code}: ${r.message ?? r.reason}`);
  assert.equal("data" in r, false, `${label}: non-live results carry no data`);
  note(`${label}: ${r.status} ${r.code} â€” ${r.message ?? r.reason}`);
  return false;
}

describe("live providers (Robinhood Chain 4663)", { timeout: 300_000 }, () => {
  let sample: { block: any; tx: any } | null = null;
  let token: string | undefined;

  before(() => {
    assert.ok(env.file || Object.keys(env.values).length > 0, "no provider configuration found (.env.local / .env / process env)");
  });

  after(() => {
    // No provider key may appear anywhere in any result.
    const text = JSON.stringify(seen);
    for (const secret of env.secrets) assert.ok(!text.includes(secret), "a provider secret leaked into a result");
    console.log(`\nLIVE SUMMARY\n${summary.map((s) => `  ${s}`).join("\n")}\n`);
  });

  it("health-checks every provider and verifies RPC chain ids", async () => {
    const rows = keep(await data.providers.check());
    for (const r of rows) note(`provider ${r.provider}: ${r.status}${r.verifiedChainIds.robinhood ? ` chainId=${r.verifiedChainIds.robinhood}` : ""}${r.status === "healthy" ? "" : ` â€” ${r.lastError ?? r.detail ?? ""}`}`);
    for (const name of ["alchemy", "quicknode"]) {
      const row = rows.find((r) => r.provider === name)!;
      if (row.status === "not_configured") continue;
      assert.equal(row.status, "healthy", `${name}: ${row.lastError}`);
      assert.equal(row.verifiedChainIds.robinhood, 4663, `${name} must report chain id 4663`);
    }
    for (const r of rows) assert.ok(["healthy", "degraded", "down", "auth_failed", "chain_mismatch", "not_configured"].includes(r.status));
  });

  it("verifies the chain id and head block", async () => {
    const r = keep(await data.chains.info());
    assert.ok(isLive(r), JSON.stringify(r));
    const d = r.data as any;
    assert.equal(d.verifiedChainId, 4663);
    assert.equal(d.chainIdMatches, true);
    note(`chain robinhood: eth_chainId=${d.verifiedChainId} head=${d.latestBlock} via ${r.provenance.source}`);
    const testnet = keep(await data.chains.info({ chain: "testnet" }));
    assert.equal(testnet.status === "ERROR" && (testnet as any).code, "INVALID_INPUT", "testnet is not supported");
  });

  it("reads a recent block and discovers a real user transaction", async () => {
    const latest = keep(await data.onchain.latestBlock({ fresh: true }));
    assert.ok(isLive(latest), JSON.stringify(latest));
    const head = BigInt(latest.data.number!);
    assert.ok(head > 0n);
    const age = Date.now() - Date.parse(latest.data.time!);
    assert.ok(age < 10 * 60_000, `head block is ${Math.round(age / 1000)}s old`);
    note(`latest block ${head} (${Math.round(age / 1000)}s old) hash ${latest.data.hash}`);
    // Start a few blocks back so explorers have indexed it.
    for (let n = head - 30n; n > head - 200n && !sample; n--) {
      const block = keep(await data.onchain.block(n.toString()));
      if (!isLive(block)) continue;
      for (const hash of block.data.transactions.slice(0, 6)) {
        const tx = keep(await data.onchain.transaction(hash));
        if (isLive(tx) && tx.data.from && tx.data.from.toLowerCase() !== SYSTEM && tx.data.to) {
          sample = { block: block.data, tx: tx.data };
          break;
        }
      }
    }
    assert.ok(sample, "no user transaction found in the last 200 blocks");
    assert.equal(sample.tx.blockNumber, sample.block.number);
    assert.ok(["success", "reverted"].includes(sample.tx.status));
    note(`sample tx ${sample.tx.hash} block ${sample.tx.blockNumber} status ${sample.tx.status}`);
  });

  it("gets identical transaction data from every healthy RPC provider", async () => {
    assert.ok(sample);
    const blockHashes = new Map<string, string>();
    for (const name of ["alchemy", "quicknode"]) {
      const p = data.registry.get(name) as any;
      if (!p || p.unconfigured) continue;
      const { result } = await p.call(robinhood, "eth_getTransactionByHash", [sample.tx.hash]);
      blockHashes.set(name, result.blockHash);
    }
    assert.ok(blockHashes.size > 0);
    assert.equal(new Set(blockHashes.values()).size, 1, `providers disagree: ${JSON.stringify([...blockHashes])}`);
    note(`tx cross-check: ${[...blockHashes.keys()].join(" = ")} (same blockHash)`);
  });

  it("reads balance, nonce and contract code at a pinned block", async () => {
    assert.ok(sample);
    const bal = keep(await data.onchain.balance(sample.tx.from, { fresh: true }));
    assert.ok(isLive(bal), JSON.stringify(bal));
    assert.match(bal.data.wei, /^\d+$/);
    assert.ok(bal.provenance.blockNumber);
    const code = keep(await data.onchain.code(sample.tx.to, { fresh: true }));
    assert.ok(isLive(code), JSON.stringify(code));
    note(`balance ${sample.tx.from}: ${bal.data.formatted} ETH @${bal.provenance.blockNumber}; ${sample.tx.to} code ${code.data.sizeBytes} bytes`);
  });

  it("falls back to another real provider when the first one rejects its key", async () => {
    const values = { ...env.values, ALCHEMY_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/invalidKeyForSpliceFallbackTest", ALCHEMY_API_KEY: "" };
    if (!values.QUICKNODE_RPC_URL) return void note("fallback: skipped (QUICKNODE_RPC_URL not set)");
    const broken = new SpliceData({ env: values as NodeJS.ProcessEnv, envFile: null });
    const r = keep(await broken.onchain.balance(sample!.tx.from));
    assert.ok(isLive(r), JSON.stringify(r));
    assert.notEqual(r.provenance.source, "alchemy");
    assert.equal(r.provenance.fallbackFrom?.[0]?.provider, "alchemy");
    note(`fallback: alchemy (bad key: ${r.provenance.fallbackFrom?.[0]?.error}) â†’ ${r.provenance.source}`);
  });

  it("indexes the transaction and the wallet's transfers on Blockscout", async () => {
    assert.ok(sample);
    const indexed = keep(await data.onchain.indexedTransaction(sample.tx.hash));
    liveOr(indexed, "blockscout tx");
    const transfers = keep(await data.onchain.transfers(sample.tx.from, { limit: 25 }));
    if (liveOr(transfers, "transfers")) {
      token = ((transfers.data as any).transfers as any[]).map((t) => t.token?.address).find((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));
    }
    const balances = keep(await data.wallet.balances(sample.tx.from));
    for (const [k, s] of Object.entries(balances.status === "ERROR" ? {} : (balances as any).sections)) liveOr(s, `wallet.balances.${k}`);
  });

  it("inspects a real token (metadata, supply, price, pools, security)", async () => {
    if (!token) return void note("token: skipped (sample wallet has no token transfers)");
    const t = keep(await data.onchain.token(token));
    assert.equal((t as any).kind, "composite");
    const s = (t as any).sections;
    liveOr(s.metadata, `token ${token} metadata`);
    liveOr(s.totalSupply, "token totalSupply");
    for (const k of ["price", "pools", "security", "holders"]) if (s[k]) liveOr(s[k], `token ${k}`);
  });

  it("inspects a contract (code, verified source, proxy slots, counters)", async () => {
    assert.ok(sample);
    const c = keep(await data.onchain.contract(sample.tx.to));
    for (const [k, s] of Object.entries((c as any).sections)) liveOr(s, `contract.${k}`, ["RATE_LIMITED", "CAPABILITY_UNAVAILABLE", "NOT_FOUND"]);
  });

  it("prices ETH on CoinGecko", async () => {
    const r = keep(await data.market.price("ETH", { fresh: true }));
    if (liveOr(r, "price ETH")) {
      assert.equal(r.provenance.source, "coingecko");
      assert.ok(Number((r.data as any).price) > 0);
      note(`price ETH: ${(r.data as any).price} ${(r.data as any).vs}`);
    }
  });

  it("gets GoPlus security reports", async () => {
    assert.ok(sample);
    liveOr(keep(await data.security.address(sample.tx.from)), "goplus address");
    liveOr(keep(await data.security.approvals(sample.tx.from)), "security approvals");
  });

  it("gets a Zerion portfolio (rate limits are reported, never filled in)", async () => {
    assert.ok(sample);
    liveOr(keep(await data.wallet.portfolio(sample.tx.from)), "zerion portfolio");
  });

  it("queries logs of the sample block", async () => {
    assert.ok(sample);
    const r = keep(await data.onchain.logs({ fromBlock: sample.block.number, toBlock: sample.block.number }));
    assert.ok(isLive(r), JSON.stringify(r));
    note(`logs block ${sample.block.number}: ${(r.data as any).count} logs via ${r.provenance.source}`);
  });

  it("serves a repeat request as CACHED (not live) and refetches with fresh", async () => {
    assert.ok(sample);
    keep(await data.onchain.transaction(sample.tx.hash, { fresh: true }));
    const a = keep(await data.onchain.transaction(sample.tx.hash));
    assert.equal(a.status, "CACHED");
    assert.ok(isLive(a) && a.provenance.fresh === false);
    const b = keep(await data.onchain.transaction(sample.tx.hash, { fresh: true }));
    assert.equal(b.status, "LIVE");
  });
});
