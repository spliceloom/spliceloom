/**
 * Unit tests for the data layer's internal logic. Provider HTTP is replaced by the documented
 * test seam (`SpliceDataOptions.fetch`) — these stubs exist only in this test file; production
 * code has no mock or fixture path. Live behaviour is covered by scripts/live/providers.live.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HttpClient, SpliceData, formatUnits, isLive, loadProviderEnv, parseProviderEnvFile, resolveChain, type DataResult } from "./index.js";

const ALCHEMY_KEY = "unitTestAlchemyKey0123456789abcdef";
const QN_TOKEN = "unitTestQuickNodeToken0123456789abcdef";
const env = {
  ALCHEMY_RPC_URL: `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  QUICKNODE_RPC_URL: `https://unit-test.robinhood-mainnet.quiknode.pro/${QN_TOKEN}/`,
  BLOCKSCOUT_API_KEY: "unit_test_blockscout_key_0123456789",
  COINGECKO_API_KEY: "CG-unitTestKey0123456789",
};

type Handler = (url: URL, body: { method?: string; params?: unknown[] } | null) => Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const rpcResult = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });

function stubbed(handler: Handler, extraEnv: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string; params?: unknown[] }) : null;
    calls.push(`${url.hostname}${body?.method ? ` ${body.method}` : url.pathname}`);
    return handler(url, body);
  };
  return { data: new SpliceData({ env: { ...env, ...extraEnv }, envFile: null, fetch }), calls };
}

/** A healthy Robinhood RPC endpoint (chain 4663) answering the given methods. */
function rpcHandler(overrides: Record<string, unknown> = {}, chainHex = "0x1237"): Handler {
  return (_url, body) => {
    const m = body?.method ?? "";
    if (m in overrides) {
      const v = overrides[m];
      return v instanceof Response ? v : rpcResult(v);
    }
    if (m === "eth_chainId") return rpcResult(chainHex);
    if (m === "eth_blockNumber") return rpcResult("0x4995a4d");
    if (m === "eth_getBalance") return rpcResult("0xde0b6b3a7640001");
    return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `the method ${m} does not exist/is not available` } });
  };
}

describe("data layer", () => {
  it("knows Robinhood Chain mainnet (4663) only", () => {
    assert.equal(resolveChain(undefined)?.chainId, 4663);
    assert.equal(resolveChain("robinhood")?.chainId, 4663);
    assert.equal(resolveChain("4663")?.key, "robinhood");
    assert.equal(resolveChain("mainnet")?.chainId, 4663);
    assert.equal(resolveChain("testnet"), null, "no testnet");
    assert.equal(resolveChain("46630"), null, "no testnet");
    assert.equal(resolveChain("ethereum"), null);
  });

  it("formats on-chain amounts exactly", () => {
    assert.equal(formatUnits(1_000000000000000001n, 18), "1.000000000000000001");
    assert.equal(formatUnits(0n, 18), "0");
    assert.equal(formatUnits(123456789n, 6), "123.456789");
    assert.equal(formatUnits(-5n, 1), "-0.5");
  });

  it("returns LIVE data with provenance (source, chain, chainId, block, fetchedAt, fresh)", async () => {
    const { data } = stubbed(rpcHandler());
    const r = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.status, "LIVE");
    assert.deepEqual(r.data, { address: "0x948951006b81b5dc954a18b639918a768447a66f", symbol: "ETH", wei: "1000000000000000001", formatted: "1.000000000000000001" });
    assert.equal(r.provenance.source, "alchemy");
    assert.equal(r.provenance.chainId, 4663);
    assert.equal(r.provenance.blockNumber, "77158989");
    assert.equal(r.provenance.fresh, true);
    assert.match(r.provenance.fetchedAt, /^\d{4}-\d\d-\d\dT/);
  });

  it("verifies the chain id and refuses a provider that reports another chain", async () => {
    const { data } = stubbed((url, body) => (url.hostname.includes("alchemy") ? rpcHandler({}, "0x1")(url, body) : rpcHandler()(url, body)));
    const r = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.ok(isLive(r));
    assert.equal(r.provenance.source, "quicknode", "Ethereum-mainnet endpoint is never used for Robinhood");
    assert.match(r.provenance.fallbackFrom?.[0]?.error ?? "", /chain id 1, expected 4663/);
    assert.equal(data.registry.healthOf("alchemy").status, "chain_mismatch");
  });

  it("falls back only to another real provider with the same capability, then fails explicitly", async () => {
    const down = stubbed((url, body) => (url.hostname.includes("alchemy") ? new Response("bad gateway", { status: 502 }) : rpcHandler()(url, body)));
    const ok = await down.data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.ok(isLive(ok));
    assert.equal(ok.provenance.source, "quicknode");
    assert.equal(ok.provenance.fallbackFrom?.[0]?.provider, "alchemy");

    const allDown = stubbed(() => new Response("unavailable", { status: 503 }));
    const failed = await allDown.data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.equal(failed.status, "ERROR");
    assert.equal(failed.status === "ERROR" && failed.code, "ALL_PROVIDERS_FAILED");
    assert.deepEqual(failed.status === "ERROR" && failed.attempts.map((a) => a.provider).slice(0, 2), ["alchemy", "quicknode"]);
    assert.equal("data" in failed, false, "no data is substituted");
  });

  it("reports CAPABILITY_UNAVAILABLE when no provider offers the capability or none is configured", async () => {
    const { data } = stubbed(rpcHandler());
    const approvals = await data.security.approvals("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.equal(approvals.status, "UNAVAILABLE");
    assert.equal(approvals.status === "UNAVAILABLE" && approvals.code, "CAPABILITY_UNAVAILABLE");
    assert.match(approvals.status === "UNAVAILABLE" ? approvals.reason : "", /security\.approvals on Robinhood Chain \(4663\)/);

    // With the keyless public RPC switched off and no keys, nothing can answer: UNAVAILABLE, no request.
    const empty = new SpliceData({ env: { ROBINHOOD_PUBLIC_RPC_URL: "off" }, envFile: null, fetch: async () => assert.fail("no request may be made") });
    const r = await empty.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.equal(r.status, "UNAVAILABLE");
    assert.ok(r.status === "UNAVAILABLE" && r.providers?.some((p) => p.provider === "alchemy" && /not set/.test(p.reason)));
  });

  it("works without any key: the official public RPC (chain id verified) and CoinGecko's keyless prices", async () => {
    const hosts: string[] = [];
    const data = new SpliceData({
      env: {},
      envFile: null,
      fetch: async (input, init) => {
        const url = new URL(input);
        hosts.push(url.hostname);
        if (url.hostname === "api.coingecko.com") {
          assert.equal((init?.headers as Record<string, string>)["x-cg-demo-api-key"], undefined, "no empty key header");
          return json({ ethereum: { usd: 2700.5 } });
        }
        const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
        return rpcHandler()(url, body);
      },
    });
    const balance = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.ok(isLive(balance), JSON.stringify(balance));
    assert.equal(balance.provenance.source, "robinhood-public-rpc");
    assert.equal(data.registry.healthOf("robinhood-public-rpc").verifiedChainIds.robinhood, 4663);
    assert.ok(hosts.includes("rpc.mainnet.chain.robinhood.com"));
    const price = await data.market.price("ETH");
    assert.ok(isLive(price) && price.provenance.source === "coingecko");
    const pools = await data.market.pools("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    assert.equal(pools.status, "UNAVAILABLE", "DEX pools need a CoinGecko key");
    assert.ok(!hosts.some((h, i) => h === "api.coingecko.com" && i > hosts.indexOf("api.coingecko.com")), "no keyless request to the onchain endpoint");
  });

  it("marks a method the plan does not offer as unsupported and moves on (never invents)", async () => {
    const { data } = stubbed((url, body) => {
      if (body?.method === "debug_traceTransaction") return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "debug_traceTransaction is not available on the Free tier" } });
      if (url.hostname === "api.blockscout.com") return new Response("internal error", { status: 500 });
      return rpcHandler()(url, body);
    });
    const r = await data.onchain.trace(`0x${"a".repeat(64)}`);
    // QuickNode refused → Blockscout raw-trace is the next real provider; it is stubbed as failing here.
    assert.notEqual(r.status, "LIVE");
    assert.ok(data.registry.unsupportedAtRuntime("quicknode").includes("trace.transaction@robinhood"));
  });

  it("turns 'no listing' into UNAVAILABLE with the provider, never a price", async () => {
    // CoinGecko and GeckoTerminal (the other real provider of token prices) both answer "no price".
    const { data } = stubbed((url) => (url.hostname === "api.coingecko.com" ? json({}) : url.hostname === "api.geckoterminal.com" ? json({ data: { attributes: { token_prices: {} } } }) : new Response("", { status: 500 })));
    const r = await data.market.price("0x047d4C0be17188892D57b10a1d90E90E5F3dA220");
    assert.equal(r.status, "UNAVAILABLE");
    assert.equal(r.status === "UNAVAILABLE" && r.provider, "coingecko");
    assert.match(r.status === "UNAVAILABLE" ? r.reason : "", /no market listing/);
    assert.match(r.status === "UNAVAILABLE" ? (r.providers ?? []).map((p) => `${p.provider}: ${p.reason}`).join(" ") : "", /geckoterminal: GeckoTerminal has no price/);
  });

  it("serves cached real data as CACHED (fresh: false, original fetchedAt) and refetches with fresh", async () => {
    const { data, calls } = stubbed(rpcHandler());
    const first = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    const second = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    assert.ok(isLive(first) && isLive(second));
    assert.equal(second.status, "CACHED");
    assert.equal(second.provenance.fresh, false);
    assert.equal(second.provenance.fetchedAt, first.provenance.fetchedAt);
    assert.ok(second.provenance.cache && second.provenance.cache.ttlMs > 0);
    const before = calls.length;
    const third = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f", { fresh: true });
    assert.equal(third.status, "LIVE");
    assert.ok(calls.length > before, "fresh: true asked the provider again");
  });

  it("rejects invalid input before any request", async () => {
    const { data, calls } = stubbed(rpcHandler());
    const results: DataResult<unknown>[] = [await data.onchain.balance("0x123"), await data.onchain.transaction("0xabc"), await data.onchain.block("nope"), await data.market.price("DOGE"), await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f", { chain: "ethereum" })];
    for (const r of results) assert.equal(r.status === "ERROR" && r.code, "INVALID_INPUT", JSON.stringify(r));
    assert.deepEqual(calls, []);
  });

  it("never leaks provider keys in errors", async () => {
    const { data } = stubbed((url) => new Response(`upstream failed for ${url.href}`, { status: 500 }));
    const r = await data.onchain.balance("0x948951006b81b5dc954a18b639918a768447a66f");
    const text = JSON.stringify(r);
    assert.ok(!text.includes(ALCHEMY_KEY), text);
    assert.ok(!text.includes(QN_TOKEN), text);
    assert.match(text, /\[REDACTED\]/);
  });

  it("normalizes the latest block and a transaction with its receipt from the same provider", async () => {
    const { data } = stubbed(
      rpcHandler({
        eth_getBlockByNumber: { number: "0x10", hash: `0x${"b".repeat(64)}`, parentHash: `0x${"c".repeat(64)}`, timestamp: "0x6553f100", gasUsed: "0x5208", gasLimit: "0x1c9c380", transactions: [`0x${"d".repeat(64)}`] },
        eth_getTransactionByHash: { hash: `0x${"d".repeat(64)}`, blockNumber: "0x10", blockHash: `0x${"b".repeat(64)}`, from: "0x948951006b81b5dc954a18b639918a768447a66f", to: null, value: "0x0", nonce: "0x2", input: "0x" },
        eth_getTransactionReceipt: { status: "0x0", blockNumber: "0x10", gasUsed: "0x5208", logs: [] },
      }),
    );
    const block = await data.onchain.latestBlock();
    assert.ok(isLive(block));
    assert.equal(block.data.number, "16");
    assert.equal(block.data.time, "2023-11-14T22:13:20.000Z");
    assert.equal(block.provenance.blockHash, `0x${"b".repeat(64)}`);
    const tx = await data.onchain.transaction(`0x${"d".repeat(64)}`);
    assert.ok(isLive(tx));
    assert.equal(tx.data.status, "reverted");
    assert.equal(tx.data.to, undefined, "contract creation has no 'to' — absent, not invented");
    const missing = stubbed(rpcHandler({ eth_getTransactionByHash: null }));
    const notFound = await missing.data.onchain.transaction(`0x${"e".repeat(64)}`);
    assert.equal(notFound.status === "ERROR" && notFound.code, "NOT_FOUND");
  });
});

describe("provider environment", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "splice-data-env-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads only the whitelisted provider variables from .env.local", () => {
    writeFileSync(join(dir, ".env.local"), ["# comment", "ALCHEMY_API_KEY=abc123def456", 'COINGECKO_API_KEY="CG-quoted123"', "DATABASE_PASSWORD=must-not-be-read", "AWS_SECRET_ACCESS_KEY=nope", "export ZERION_API_KEY=zk_x1234567"].join("\n"));
    const loaded = loadProviderEnv({ env: {}, cwd: join(dir) });
    assert.deepEqual(loaded.values, { ALCHEMY_API_KEY: "abc123def456", COINGECKO_API_KEY: "CG-quoted123", ZERION_API_KEY: "zk_x1234567" });
    assert.ok(!JSON.stringify(loaded).includes("must-not-be-read"));
    assert.deepEqual(parseProviderEnvFile("SECRET=1\nGOPLUS_APP_KEY=k"), { GOPLUS_APP_KEY: "k" });
    // process env wins over the file
    assert.equal(loadProviderEnv({ env: { ALCHEMY_API_KEY: "fromenv123" }, cwd: dir }).values.ALCHEMY_API_KEY, "fromenv123");
    // URL-embedded keys are treated as secrets
    const urls = loadProviderEnv({ env: { QUICKNODE_RPC_URL: "https://name-x.robinhood-mainnet.quiknode.pro/0123456789abcdef0123/" }, file: null });
    assert.ok(urls.secrets.includes("0123456789abcdef0123"));
    assert.ok(urls.secrets.includes("name-x"), "QuickNode endpoint name is account-specific");
    const alchemy = loadProviderEnv({ env: { ALCHEMY_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/abcdefabcdefabcdef12" }, file: null });
    assert.ok(!alchemy.secrets.includes("robinhood-mainnet"), "public network labels are not secrets");
  });

  it("falls back to <SPLICE_HOME>/.env when no project file exists", () => {
    const base = mkdtempSync(join(tmpdir(), "splice-data-home-"));
    const home = join(base, "home");
    const empty = join(base, "empty");
    mkdirSync(home);
    mkdirSync(empty);
    writeFileSync(join(home, ".env"), "CODEX_API_KEY=user-level-key\n");
    const loaded = loadProviderEnv({ env: { SPLICE_HOME: home }, cwd: empty });
    assert.equal(loaded.file, join(home, ".env"));
    assert.equal(loaded.values.CODEX_API_KEY, "user-level-key");
    // a project file wins over the user file
    assert.equal(loadProviderEnv({ env: { SPLICE_HOME: home }, cwd: dir }).values.CODEX_API_KEY, undefined);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("network guard for providers", () => {
  it("only contacts the provider's own hosts and never private addresses", async () => {
    const http = new HttpClient({ hosts: ["api.coingecko.com"], secrets: [] });
    await assert.rejects(http.json("https://evil.example.com/steal"), /blocked by the Splice network guard/);
    await assert.rejects(http.json("http://169.254.169.254/latest/meta-data/"), /blocked by the Splice network guard/);
  });
});
