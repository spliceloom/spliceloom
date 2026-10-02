/**
 * MCP live data tools. Provider HTTP is replaced through the data layer's test seam
 * (SpliceDataOptions.fetch) in this file only; production servers use real providers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SpliceProject } from "@spliceloom/core";
import { SpliceData } from "@spliceloom/data";
import { SpliceMcpServer, type JsonRpcResponse } from "./index.js";

const RPC_KEY = "mcpUnitTestAlchemyKey0123456789";

function rpcStub() {
  return async (_input: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const result = method === "eth_chainId" ? "0x1237" : method === "eth_blockNumber" ? "0x100" : method === "eth_getBalance" ? "0x2a" : null;
    return new Response(JSON.stringify(result === null ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not available" } } : { jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

describe("mcp data tools", () => {
  let root: string;
  let projectRoot: string;
  let id = 1;
  const call = async (server: SpliceMcpServer, method: string, params?: unknown) => {
    const response = (await server.handle({ jsonrpc: "2.0", id: id++, method, ...(params === undefined ? {} : { params }) })) as JsonRpcResponse;
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result as Record<string, any>;
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-mcp-data-"));
    projectRoot = (await SpliceProject.init(join(root, "project"))).project.root;
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("are exposed only when the data layer is enabled", async () => {
    const plain = new SpliceMcpServer({ projectRoot, serverVersion: "0.0.0-test" });
    assert.deepEqual((await call(plain, "tools/list")).tools, []);
    const withData = new SpliceMcpServer({ projectRoot, serverVersion: "0.0.0-test", data: new SpliceData({ env: {}, envFile: null }) });
    const names = ((await call(withData, "tools/list")).tools as Array<{ name: string; annotations: Record<string, unknown> }>).map((t) => t.name);
    for (const n of ["onchain_get_balance", "onchain_get_transaction", "onchain_get_token", "onchain_get_contract", "onchain_get_transfers", "onchain_get_logs", "market_get_price", "security_get_token", "wallet_get_portfolio"]) {
      assert.ok(names.includes(n), n);
    }
  });

  it("return LIVE results with provenance and never expose provider keys", async () => {
    const data = new SpliceData({ env: { ALCHEMY_RPC_URL: `https://robinhood-mainnet.g.alchemy.com/v2/${RPC_KEY}` }, envFile: null, fetch: rpcStub() });
    const server = new SpliceMcpServer({ projectRoot, serverVersion: "0.0.0-test", data });
    const r = await call(server, "tools/call", { name: "onchain_get_balance", arguments: { address: "0x948951006b81b5dc954a18b639918a768447a66f" } });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.status, "LIVE");
    assert.equal(r.structuredContent.data.wei, "42");
    assert.deepEqual([r.structuredContent.provenance.source, r.structuredContent.provenance.chainId, r.structuredContent.provenance.blockNumber, r.structuredContent.provenance.fresh], ["alchemy", 4663, "256", true]);
    const providers = await call(server, "tools/call", { name: "providers_status", arguments: {} });
    assert.ok(!JSON.stringify(providers).includes(RPC_KEY));
    assert.ok(!JSON.stringify(r).includes(RPC_KEY));
  });

  it("expose AI, GitHub and market tools with provenance and without the keys", async () => {
    const token = "github_pat_mcpUnitTestToken0000000000000000000000000";
    const data = new SpliceData({
      env: { GITHUB_TOKEN: token },
      envFile: null,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.hostname === "api.github.com") return new Response(JSON.stringify({ full_name: "o/r", name: "r", stargazers_count: 1, message: token }), { status: 200 });
        return new Response("{}", { status: 500 });
      },
    });
    const server = new SpliceMcpServer({ projectRoot, serverVersion: "0.0.0-test", data });
    const names = ((await call(server, "tools/list")).tools as Array<{ name: string }>).map((t) => t.name);
    for (const n of ["ai_generate", "ai_models", "github_repository", "github_search_repositories", "github_contents", "github_commits", "github_raw", "market_token", "market_pairs", "market_token_price", "market_ohlcv", "web_search", "web_extract", "web_map", "web_similar", "web_answer"]) assert.ok(names.includes(n), n);
    const r = await call(server, "tools/call", { name: "github_repository", arguments: { repo: "o/r" } });
    assert.equal(r.structuredContent.status, "LIVE");
    assert.equal(r.structuredContent.provenance.source, "github");
    assert.equal(r.structuredContent.data.stars, 1);
    assert.ok(!JSON.stringify(r).includes(token));
    const bad = await call(server, "tools/call", { name: "ai_generate", arguments: { prompt: "x", apiKey: "nope" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /INVALID_INPUT/);
    const raw = await call(server, "tools/call", { name: "github_raw", arguments: { url: "https://evil.example.com/o/r/main/file.txt" } });
    assert.equal(raw.isError, true);
    assert.match(raw.content[0].text, /only raw\.githubusercontent\.com/);
  });

  it("report UNAVAILABLE as data-less results and validate input before any request", async () => {
    const data = new SpliceData({ env: {}, envFile: null, fetch: async () => assert.fail("no provider may be contacted") });
    const server = new SpliceMcpServer({ projectRoot, serverVersion: "0.0.0-test", data });
    // Wallet portfolios need a Zerion key: without one the tool is UNAVAILABLE and nothing is contacted.
    const portfolio = await call(server, "tools/call", { name: "wallet_get_portfolio", arguments: { address: "0x948951006b81b5dc954a18b639918a768447a66f" } });
    assert.equal(portfolio.structuredContent.status, "UNAVAILABLE");
    assert.equal(portfolio.structuredContent.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(portfolio.structuredContent.data, undefined);
    const bad = await call(server, "tools/call", { name: "onchain_get_balance", arguments: { address: "0x12", extra: 1 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /INVALID_INPUT/);
  });
});
