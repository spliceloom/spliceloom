import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { agentTools, forModel } from "./commands/ask.js";
import { pct, renderMarkdown, table, usdCompact, usdPrice } from "./format.js";
import { createStyle } from "./io.js";
import { COMMAND_OPTIONS, main } from "./cli.js";
import { COMMAND_HELP } from "./help.js";

const HOME = mkdtempSync(join(tmpdir(), "splice-ask-home-"));
const DIR = mkdtempSync(join(tmpdir(), "splice-ask-"));
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(DIR, { recursive: true, force: true });
});

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POOLS = {
  data: [
    {
      id: "robinhood_0x01",
      type: "pool",
      attributes: { address: "0x01", name: "MOON / WETH", base_token_price_usd: "0.0123", reserve_in_usd: "250000", price_change_percentage: { h1: "4.2", h6: "12", h24: "321.5" }, volume_usd: { h1: "1000", h6: "8000", h24: "1500000" }, transactions: { h24: { buys: 120, sells: 80 } }, pool_created_at: new Date(Date.now() - 50 * 3_600_000).toISOString() },
      relationships: { base_token: { data: { id: "robinhood_0xa1" } }, quote_token: { data: { id: `robinhood_${WETH}` } }, dex: { data: { id: "uniswap-v4-robinhood" } } },
    },
  ],
  included: [
    { id: "robinhood_0xa1", type: "token", attributes: { address: "0xa1", symbol: "MOON", name: "Moon" } },
    { id: `robinhood_${WETH}`, type: "token", attributes: { address: WETH, symbol: "WETH", name: "Wrapped Ether" } },
  ],
};

function fakeProviders(log: Array<{ url: string; body?: unknown }>) {
  let aiCalls = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    log.push({ url, body });
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      aiCalls++;
      if (aiCalls === 1) {
        return Response.json({ id: "a", model: "openai/gpt-4o-mini", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "market_movers", arguments: JSON.stringify({ kind: "gainers" }) } }] } }], usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0.0002 } });
      }
      return Response.json({ id: "b", model: "openai/gpt-4o-mini", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "## Top gainer\n**MOON** naik +321.5% dalam 24 jam (sumber: coingecko)." } }], usage: { prompt_tokens: 1500, completion_tokens: 40, cost: 0.0003 } });
    }
    if (url.includes("/onchain/networks/robinhood/pools?sort=h24_volume_usd_desc&page=1")) return Response.json(POOLS);
    if (url.includes("/onchain/networks/robinhood/")) return Response.json({ data: [], included: [] });
    return new Response("not mocked", { status: 500 });
  };
}

async function run(argv: string[], log: Array<{ url: string; body?: unknown }>) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: DIR,
    env: { SPLICE_HOME: HOME, OPENROUTER_API_KEY: "sk-or-test-key", COINGECKO_API_KEY: "cg-demo", ROBINHOOD_PUBLIC_RPC_URL: "off" },
    color: false,
    dataFetch: fakeProviders(log),
  });
  return { code, stdout, stderr };
}

describe("splice ask (live-data agent)", () => {
  it("lets the model call data tools, feeds the results back and prints the answer with sources and cost", async () => {
    const log: Array<{ url: string; body?: unknown }> = [];
    const r = await run(["ask", "token apa yang paling naik?"], log);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Top gainer/);
    assert.doesNotMatch(r.stdout, /##|\*\*/, "markdown is rendered for the terminal");
    assert.match(r.stderr, /✓ market_movers {2}kind=gainers {2}→ LIVE coingecko/);
    assert.match(r.stderr, /1 tool call · sources: coingecko · model openai\/gpt-4o-mini · cost 0\.000500 USD/);
    const ai = log.filter((l) => l.url.includes("openrouter.ai"));
    assert.equal(ai.length, 2);
    const first = ai[0]!.body as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }>; model: string };
    assert.equal(first.model, "openai/gpt-4o-mini", "default model when AI_DEFAULT_MODEL is not set");
    assert.ok(first.tools.some((t) => t.function.name === "stock_quote"));
    assert.ok(!first.tools.some((t) => t.function.name === "ai_generate"), "no model-calls-model tool");
    assert.match(first.messages[0]!.content, /Never answer such facts from memory/);
    const second = ai[1]!.body as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
    const tool = second.messages.find((m) => m.role === "tool")!;
    assert.equal(tool.tool_call_id, "call_1");
    assert.match(tool.content, /"symbol":"MOON"/);
    assert.match(tool.content, /"source":"coingecko"/);
    assert.ok(!JSON.stringify(log.map((l) => l.body)).includes("sk-or-test-key"), "the key is never sent in a body");
  });

  it("--json prints the answer, tool calls and cost", async () => {
    const r = await run(["ask", "gainers?", "--json"], []);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { answer: string; toolCalls: Array<{ name: string; status: string; source: string }>; costUsd: number };
    assert.deepEqual(out.toolCalls.map((c) => [c.name, c.status, c.source]), [["market_movers", "LIVE", "coingecko"]]);
    assert.equal(out.costUsd, 0.0005);
    assert.equal(r.stderr, "", "no progress lines in JSON mode");
  });

  it("without a question and without a terminal it is a usage error", async () => {
    assert.equal((await run(["ask"], [])).code, 2);
  });

  it("every agent tool has a JSON schema and results are trimmed for the model", () => {
    const tools = agentTools();
    assert.ok(tools.length >= 35 && tools.length <= 128, String(tools.length));
    for (const t of tools) assert.equal((t.parameters as { type?: string }).type, "object", t.name);
    const big = forModel({ status: "LIVE", data: { pools: Array.from({ length: 100 }, (_, i) => ({ i, abi: "x".repeat(10_000) })) } }, 5_000);
    assert.ok(big.length <= 5_020);
    assert.doesNotMatch(big, /"abi"/);
  });
});

describe("market tables", () => {
  it("prints movers as a table with the ranking formula", async () => {
    const r = await run(["market", "gainers"], []);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /market gainers {2}● LIVE {2}source=coingecko/);
    assert.match(r.stdout, /TOKEN\s+PAIR\s+PRICE\s+1H\s+6H\s+24H\s+VOL 24H\s+LIQUIDITY/);
    assert.match(r.stdout, /1\s+MOON\s+MOON \/ WETH\s+\$0\.01230\s+\+4\.2%\s+\+12\.0%\s+\+322%\s+\$1\.50M\s+\$250K\s+120\/80\s+2d/);
    assert.match(r.stdout, /ranking: largest positive price change over h24/);
  });

  it("formats numbers without inventing values", () => {
    const s = createStyle(false);
    assert.equal(usdCompact("1500000"), "$1.50M");
    assert.equal(usdCompact(undefined), "—");
    assert.equal(usdPrice("2703.4"), "$2,703.40");
    assert.equal(usdPrice("0.0001234"), "$0.0001234");
    assert.equal(pct(s, "-4.56"), "-4.6%");
    assert.equal(pct(s, null), "—");
    assert.deepEqual(table(s, ["A", "BB"], [["x", "1"], ["yyy", "22"]], ["left", "right"]), ["  A    BB", "  x     1", "  yyy  22"]);
    assert.equal(renderMarkdown(s, "### Title\n**bold** [link](https://x.test)"), "Title\nbold link (https://x.test)");
  });

  it("every command has help and documented options", () => {
    for (const command of ["ask", "chat", "stock", "oracle", "market"]) {
      assert.ok(COMMAND_HELP[command], command);
      assert.ok(COMMAND_OPTIONS[command], command);
    }
  });
});
