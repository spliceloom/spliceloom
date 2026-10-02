/**
 * Unit tests for the AI, GitHub and market providers and their routing. Provider HTTP is replaced
 * through the SpliceDataOptions.fetch test seam in this file only (production code has no mock
 * path); the live suite (scripts/live/*.live.test.ts) calls the real providers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpClient, SpliceData, isLive, loadProviderEnv, parseRawUrl } from "./index.js";

const OR_KEY = "sk-or-v1-unitTestOpenRouterKey000000000000000000000000000000";
const GEMINI_KEY = "AIzaUnitTestGeminiKey0000000000000000000";
const GH_TOKEN = "github_pat_unitTestToken000000000000000000000000000000";

type Route = (url: URL, init: RequestInit | undefined, body: any) => Response | Promise<Response>;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

function make(route: Route, env: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    return route(url, init, body);
  };
  return { data: new SpliceData({ env, envFile: null, fetch }), calls };
}

const completion = (extra: Record<string, unknown> = {}) =>
  json({ id: "gen-1", model: "openai/gpt-4o-mini", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "pong", ...extra } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.000001 } });

describe("AI providers and routing", () => {
  const env = { OPENROUTER_API_KEY: OR_KEY, AI_DEFAULT_MODEL: "openai/gpt-4o-mini" };

  it("returns the real completion with usage, actual model, upstream provider and routing", async () => {
    let sent: any;
    const { data } = make((url, init, body) => {
      assert.equal(url.href, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${OR_KEY}`);
      sent = body;
      return completion();
    }, env);
    const r = await data.ai.generate({ prompt: "ping", system: "be brief", maxTokens: 5 });
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.data.text, "pong");
    assert.deepEqual(r.data.usage, { promptTokens: 5, completionTokens: 1, totalTokens: 6, costUsd: 0.000001 });
    assert.equal(r.data.upstreamProvider, "OpenAI");
    assert.deepEqual(r.data.routing, { requestedProvider: "openrouter", requestedModel: "openai/gpt-4o-mini", actualProvider: "openrouter", actualModel: "openai/gpt-4o-mini", fallback: false });
    assert.equal(r.provenance.source, "openrouter");
    assert.equal(r.provenance.chain, "global");
    assert.equal(r.provenance.chainId, null);
    assert.equal(r.provenance.requestId, "gen-1");
    assert.deepEqual(sent.messages, [{ role: "system", content: "be brief" }, { role: "user", content: "ping" }]);
    assert.deepEqual(sent.usage, { include: true });
    // AI results are never cached
    const again = await data.ai.generate({ prompt: "ping" });
    assert.equal(again.status, "LIVE");
  });

  it("normalizes tool calls and structured output; invalid JSON is reported, never invented", async () => {
    const tools = make(() => completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] }), env);
    const t = await tools.data.ai.generate({ prompt: "use the tool", tools: [{ name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }] });
    assert.ok(isLive(t));
    assert.equal(t.capability, "ai.tools");
    assert.deepEqual(t.data.toolCalls, [{ id: "c1", name: "lookup", arguments: '{"q":"x"}' }]);
    assert.equal(t.data.text, undefined);

    const ok = make(() => completion({ content: '{"capital":"Paris"}' }), env);
    const s = await ok.data.ai.generate({ prompt: "capital?", responseSchema: { name: "answer", schema: { type: "object" } } });
    assert.ok(isLive(s));
    assert.equal(s.capability, "ai.structured_output");
    assert.deepEqual(s.data.structured, { capital: "Paris" });

    const bad = make(() => completion({ content: "Paris" }), env);
    const b = await bad.data.ai.generate({ prompt: "capital?", responseSchema: { name: "answer", schema: { type: "object" } } });
    assert.ok(isLive(b));
    assert.equal(b.data.structured, undefined);
    assert.match(b.provenance.notes?.join(" ") ?? "", /not valid JSON/);
  });

  it("never switches provider silently: without a configured fallback a failure is an error", async () => {
    const { data, calls } = make((url) => (url.hostname === "openrouter.ai" ? json({ error: { message: "upstream down" } }, 503) : assert.fail(`unexpected ${url.href}`)), { ...env, GEMINI_API_KEY: GEMINI_KEY });
    const r = await data.ai.generate({ prompt: "ping" });
    assert.equal(r.status, "ERROR");
    assert.ok(calls.every((c) => c.includes("openrouter.ai")), "gemini was not asked");
  });

  it("uses a configured fallback and records requested vs. actual provider/model and the reason", async () => {
    const { data } = make(
      (url) => {
        if (url.hostname === "openrouter.ai") return json({ error: { message: "insufficient credits" } }, 402);
        assert.equal(url.pathname, "/v1beta/models/gemini-2.5-flash:generateContent");
        return json({ responseId: "r1", modelVersion: "gemini-2.5-flash", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "pong" }, { functionCall: { name: "f", args: { a: 1 } } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } });
      },
      { ...env, GEMINI_API_KEY: GEMINI_KEY, AI_FALLBACK_PROVIDER: "gemini", AI_FALLBACK_MODEL: "gemini-2.5-flash" },
    );
    const r = await data.ai.generate({ prompt: "ping" });
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.data.provider, "gemini");
    assert.deepEqual(r.data.toolCalls, [{ name: "f", arguments: '{"a":1}' }]);
    assert.equal(r.data.routing.fallback, true);
    assert.equal(r.data.routing.requestedProvider, "openrouter");
    assert.equal(r.data.routing.actualModel, "gemini-2.5-flash");
    assert.match(r.data.routing.fallbackReason ?? "", /openrouter: OpenRouter HTTP 402: insufficient credits/);
    // fallback: false disables it for one request
    const strict = await data.ai.generate({ prompt: "ping", fallback: false });
    assert.equal(strict.status, "ERROR");
  });

  it("refuses invalid requests (no request made) and does not fall back on a rejected request", async () => {
    const { data, calls } = make(() => json({ error: { message: "openai/nope is not a valid model ID" } }, 400), { OPENROUTER_API_KEY: OR_KEY, GEMINI_API_KEY: GEMINI_KEY, AI_FALLBACK_PROVIDER: "gemini", AI_FALLBACK_MODEL: "gemini-2.5-flash" });
    const tooLong = await data.ai.generate({ prompt: "x".repeat(200_001), model: "m" });
    assert.equal(tooLong.status === "ERROR" && tooLong.code, "INVALID_INPUT");
    const badTokens = await data.ai.generate({ prompt: "x", model: "m", maxTokens: 0 });
    assert.equal(badTokens.status === "ERROR" && badTokens.code, "INVALID_INPUT");
    const badImage = await data.ai.generate({ messages: [{ role: "user", content: [{ type: "image_url", url: "file:///etc/passwd" }] }], model: "m" });
    assert.equal(badImage.status === "ERROR" && badImage.code, "INVALID_INPUT");
    assert.equal(calls.length, 0, "invalid input never reaches a provider");
    const rejected = await data.ai.generate({ prompt: "x", model: "openai/nope" });
    assert.equal(rejected.status === "ERROR" && rejected.code, "PROVIDER_ERROR");
    assert.ok(calls.every((c) => c.includes("openrouter.ai")), "a rejected request is not retried elsewhere");
    // Without a model argument or AI_DEFAULT_MODEL, the provider's known default is requested.
    const before = calls.length;
    const defaulted = await data.ai.generate({ prompt: "x" });
    assert.equal(defaulted.status === "ERROR" && defaulted.code, "PROVIDER_ERROR");
    assert.equal(calls.length, before + 1);
  });

  it("reports an unconfigured provider as not_configured / UNAVAILABLE, never healthy", async () => {
    const { data, calls } = make(() => assert.fail("no request"), { AI_DEFAULT_MODEL: "m" });
    const r = await data.ai.generate({ prompt: "x" });
    assert.equal(r.status, "UNAVAILABLE");
    assert.equal(data.registry.healthOf("gemini").status, "not_configured");
    assert.equal(data.registry.healthOf("openrouter").status, "not_configured");
    const rows = await data.providers.check();
    assert.equal(rows.find((p) => p.provider === "gemini")?.status, "not_configured");
    assert.ok(!calls.some((c: string) => c.includes("openrouter") || c.includes("googleapis")));
  });

  it("never leaks the AI key, even when the provider echoes it", async () => {
    const { data } = make(() => json({ error: { message: `bad key ${OR_KEY}` } }, 500), env);
    const r = await data.ai.generate({ prompt: "x" });
    assert.ok(!JSON.stringify(r).includes(OR_KEY));
    assert.match(JSON.stringify(r), /\[REDACTED\]/);
  });
});

describe("GitHub providers", () => {
  const repoBody = { full_name: "o/r", name: "r", owner: { login: "o" }, default_branch: "main", stargazers_count: 7, private: false, html_url: "https://github.com/o/r" };

  it("uses the token, normalizes, and reports rate-limit headers and request id", async () => {
    const { data } = make(
      (url, init) => {
        assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${GH_TOKEN}`);
        assert.equal((init?.headers as Record<string, string>)["x-github-api-version"], "2022-11-28");
        return json(repoBody, 200, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1790000000", "x-github-request-id": "ABC" });
      },
      { GITHUB_TOKEN: GH_TOKEN },
    );
    const r = await data.github.repository("o/r");
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.provenance.source, "github");
    assert.deepEqual(r.data, { fullName: "o/r", owner: "o", name: "r", private: false, defaultBranch: "main", stars: 7, url: "https://github.com/o/r" });
    assert.deepEqual(r.provenance.rateLimit, { limit: 5000, remaining: 4999, resetAt: new Date(1790000000 * 1000).toISOString() });
    assert.equal(r.provenance.requestId, "ABC");
    assert.equal(r.provenance.resource, "repos/o/r");
  });

  it("falls back to the anonymous API when the token is rejected, and records it", async () => {
    const { data } = make((_url, init) => ((init?.headers as Record<string, string>).authorization ? json({ message: "Bad credentials" }, 401) : json(repoBody)), { GITHUB_TOKEN: GH_TOKEN });
    const r = await data.github.repository("o/r");
    assert.ok(isLive(r));
    assert.equal(r.provenance.source, "github-public");
    assert.match(r.provenance.fallbackFrom?.[0]?.error ?? "", /Bad credentials/);
    assert.equal(data.registry.healthOf("github").status, "auth_failed");
  });

  it("maps 403 rate limit, 403 forbidden, 404 and 409 precisely — never to empty results", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const limited = make(() => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }));
    const a = await limited.data.github.repository("o/r");
    assert.equal(a.status === "ERROR" && a.code, "RATE_LIMITED");
    const forbidden = make(() => json({ message: "Resource not accessible" }, 403, { "x-ratelimit-remaining": "40" }));
    const b = await forbidden.data.github.repository("o/r");
    assert.equal(b.status === "ERROR" && b.code, "PROVIDER_ERROR");
    const missing = make(() => json({ message: "Not Found" }, 404));
    const c = await missing.data.github.repository("o/missing");
    assert.equal(c.status === "ERROR" && c.code, "NOT_FOUND");
    const empty = make(() => json({ message: "Git Repository is empty." }, 409));
    const d = await empty.data.github.commits("o/r");
    assert.equal(d.status === "ERROR" && d.code, "PROVIDER_ERROR");
    assert.match(d.status === "ERROR" ? d.message : "", /409/);
  });

  it("returns a real empty list with pagination when GitHub returns one", async () => {
    const { data } = make((url) => {
      assert.equal(url.searchParams.get("per_page"), "2");
      return json([], 200, { link: '<https://api.github.com/repositories/1/issues?page=3&per_page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=9&per_page=2>; rel="last"' });
    });
    const r = await data.github.issues("o/r", { page: 2, perPage: 2 });
    assert.ok(isLive(r));
    assert.deepEqual(r.data, { items: [], page: 2, perPage: 2, nextPage: 3, lastPage: 9 });
  });

  it("decodes file contents and removes pull requests from issue lists (with a note)", async () => {
    const file = make(() => json({ type: "file", path: "README.md", size: 5, sha: "s", encoding: "base64", content: Buffer.from("hello").toString("base64"), html_url: "u" }));
    const f = await file.data.github.contents("o/r", "README.md", { ref: "main" });
    assert.ok(isLive(f));
    assert.deepEqual(f.data, { repository: "o/r", path: "README.md", ref: "main", type: "file", size: 5, sha: "s", url: "u", content: "hello" });
    const issues = make(() => json([{ number: 1, title: "bug", state: "open" }, { number: 2, title: "pr", pull_request: {} }]));
    const i = await issues.data.github.issues("o/r");
    assert.ok(isLive(i));
    assert.deepEqual((i.data as { items: Array<{ number: number }> }).items.map((x) => x.number), [1]);
    assert.match(i.provenance.notes?.[0] ?? "", /1 pull request/);
  });

  it("code search and the authenticated user need the token; without it they are unavailable/rejected", async () => {
    const { data, calls } = make(() => assert.fail("no request expected"));
    const code = await data.github.searchCode("fetch");
    assert.equal(code.status, "UNAVAILABLE");
    const me = await data.github.user();
    assert.equal(me.status === "ERROR" && me.code, "PROVIDER_ERROR");
    assert.deepEqual(calls, []);
  });

  it("validates repository names, paths and refs before any request", async () => {
    const { data, calls } = make(() => assert.fail("no request"));
    for (const r of [await data.github.repository("../etc"), await data.github.contents("o/r", "../../secret"), await data.github.contents("o/r", "a", { ref: "a..b" }), await data.github.issues("o/r", { perPage: 500 })]) {
      assert.equal(r.status === "ERROR" && r.code, "INVALID_INPUT", JSON.stringify(r));
    }
    assert.deepEqual(calls, []);
  });

  it("accepts only https://raw.githubusercontent.com raw URLs", () => {
    assert.deepEqual(parseRawUrl("https://raw.githubusercontent.com/o/r/main/dir/file.txt"), { owner: "o", repo: "r", ref: "main", path: "dir/file.txt" });
    assert.deepEqual(parseRawUrl("https://raw.githubusercontent.com/o/r/refs/heads/dev/a.md"), { owner: "o", repo: "r", ref: "refs/heads/dev", path: "a.md" });
    for (const bad of [
      "http://raw.githubusercontent.com/o/r/main/a",
      "https://raw.githubusercontent.com.evil.com/o/r/main/a",
      "https://evil.com/o/r/main/a",
      "https://raw.githubusercontent.com:8443/o/r/main/a",
      "https://user:pw@raw.githubusercontent.com/o/r/main/a",
      "https://raw.githubusercontent.com/o/r/main/../../x",
      "https://raw.githubusercontent.com/o/r/main/%2e%2e/x",
      "https://raw.githubusercontent.com/o/r/main/a?token=x",
      "https://raw.githubusercontent.com/o/r",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      assert.equal(typeof parseRawUrl(bad), "string", bad);
    }
  });

  it("fetches raw files only from raw.githubusercontent.com without sending the token", async () => {
    const { data } = make(
      (url, init) => {
        assert.equal(url.hostname, "raw.githubusercontent.com");
        assert.equal((init?.headers as Record<string, string>).authorization, undefined);
        return new Response("file body", { status: 200, headers: { "content-type": "text/plain" } });
      },
      { GITHUB_TOKEN: GH_TOKEN },
    );
    const r = await data.github.raw("https://raw.githubusercontent.com/o/r/main/a.txt");
    assert.ok(isLive(r));
    assert.equal((r.data as { content: string }).content, "file body");
    const bad = await data.github.raw("https://example.com/o/r/main/a.txt");
    assert.equal(bad.status === "ERROR" && bad.code, "INVALID_INPUT");
  });
});

describe("market providers", () => {
  const pair = { chainId: "robinhood", dexId: "uniswap", pairAddress: "0xp", baseToken: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", name: "WETH", symbol: "WETH" }, quoteToken: { address: "0xq", symbol: "USDG" }, priceUsd: "2700.1", liquidity: { usd: 1000.5 }, volume: { h24: 10 }, txns: { h24: { buys: 3, sells: 2 } }, fdv: 5, marketCap: 4 };
  const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

  it("maps Robinhood to the verified provider ids and keeps provider values unchanged", async () => {
    const { data, calls } = make((url) => {
      assert.equal(url.href, `https://api.dexscreener.com/token-pairs/v1/robinhood/${WETH}`);
      return json([pair]);
    });
    const r = await data.market.pairs("4663", WETH);
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.provenance.chainId, 4663);
    const p = (r.data as unknown as { pairs: Array<Record<string, unknown>> }).pairs[0]!;
    assert.equal(p.priceUsd, "2700.1");
    assert.equal(p.liquidityUsd, "1000.5");
    assert.deepEqual(p.transactions, { h24: { buys: 3, sells: 2 } });
    assert.equal(calls.length, 1);
  });

  it("never substitutes another chain: unknown networks are UNAVAILABLE", async () => {
    const { data, calls } = make((url) => {
      if (url.pathname.startsWith("/api/v2/networks") && url.searchParams.has("page")) return json({ data: [{ id: "eth", attributes: { name: "Ethereum" } }], links: { next: null } });
      if (url.hostname === "api.dexscreener.com") return json([]);
      return assert.fail(`unexpected ${url.href}`);
    });
    const legacy = await data.market.pairs("robinhood-testnet", WETH);
    assert.equal(legacy.status, "UNAVAILABLE", "no testnet: the id is just an unknown network");
    assert.ok(!calls.some((c) => c.includes("/robinhood/")), "no request for Robinhood mainnet instead");
    const unknown = await data.market.pairs("notachain", WETH);
    assert.equal(unknown.status, "UNAVAILABLE");
    assert.match(unknown.status === "UNAVAILABLE" ? (unknown.providers ?? []).map((p) => p.reason).join(" ") : "", /GeckoTerminal does not list a network "notachain"/);
  });

  it("falls through 'no data' to the next real provider and records it", async () => {
    const { data } = make((url) => {
      if (url.hostname === "api.dexscreener.com") return json([]);
      return json({ data: [{ attributes: { address: "0xpool", name: "WETH / USDG", reserve_in_usd: "99" }, relationships: { base_token: { data: { id: `robinhood_${WETH}`, type: "token" } } } }], included: [{ id: `robinhood_${WETH}`, type: "token", attributes: { address: WETH, symbol: "WETH" } }] });
    });
    const r = await data.market.pairs("robinhood", WETH);
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.provenance.source, "geckoterminal");
    assert.match(r.provenance.fallbackFrom?.[0]?.error ?? "", /no data: DexScreener returned no pairs/);
    assert.equal((r.data as { pairs: Array<{ liquidityUsd: string; baseToken: { symbol: string } }> }).pairs[0]!.baseToken.symbol, "WETH");
  });

  it("quotes keep one section per provider, never a merged value", async () => {
    const { data } = make((url) => {
      if (url.hostname === "api.dexscreener.com") return json([pair]);
      if (url.hostname === "api.geckoterminal.com") return json({ data: { attributes: { address: WETH, symbol: "WETH", price_usd: "2699.5" } } });
      return json({ [WETH.toLowerCase()]: { usd: 2700 } });
    }, { COINGECKO_API_KEY: "CG-unitTestKey000000" });
    const q = await data.market.quotes("robinhood", WETH);
    assert.equal("kind" in q && q.kind, "composite");
    const sections = (q as { sections: Record<string, { status: string; provenance?: { source: string } }> }).sections;
    assert.equal(sections.dexscreener?.provenance?.source, "dexscreener");
    assert.equal(sections.geckoterminal?.provenance?.source, "geckoterminal");
    assert.equal(sections.price?.provenance?.source, "coingecko");
    assert.equal((sections.geckoterminal as unknown as { data: { priceUsd: string } }).data.priceUsd, "2699.5", "each source keeps its own value");
  });

  it("caches real market data with request identity and expiry, and enforces the client-side rate limit", async () => {
    const { data } = make(() => json([pair]));
    await data.market.pairs("robinhood", WETH);
    const cached = await data.market.pairs("robinhood", WETH);
    assert.equal(cached.status, "CACHED");
    assert.ok(isLive(cached) && cached.provenance.cache?.key.includes(WETH.toLowerCase()) && cached.provenance.cache.expiresAt);
    const http = new HttpClient({ hosts: ["x.test"], secrets: [], rateLimit: { requests: 1, perMs: 60_000 }, fetch: async () => json({}) });
    await http.json("https://x.test/a");
    await assert.rejects(http.json("https://x.test/b"), /client-side rate limit/);
  });

  it("validates networks and addresses before any request", async () => {
    const { data, calls } = make(() => assert.fail("no request"));
    for (const r of [await data.market.pairs("robinhood", "0x12"), await data.market.pairs("../../x", WETH), await data.market.ohlcv("robinhood", "0xp".padEnd(42, "0"), { timeframe: "hour", aggregate: 2 }), await data.market.search("")]) {
      assert.equal(r.status === "ERROR" && r.code, "INVALID_INPUT", JSON.stringify(r));
    }
    assert.deepEqual(calls, []);
  });
});

describe("web providers", () => {
  const keys = { TAVILY_API_KEY: "tvly-unitTestKey000000000000000000", EXA_API_KEY: "unitTest-exa-0000-0000-000000000000", FIRECRAWL_API_KEY: "fc-unitTest000000000000000000000000" };

  it("searches with Tavily first, normalizes results and reports credits and request id", async () => {
    const { data } = make((url, init, body) => {
      assert.equal(url.href, "https://api.tavily.com/search");
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${keys.TAVILY_API_KEY}`);
      assert.equal(body.max_results, 2);
      return json({ request_id: "t1", results: [{ url: "https://a.example/x", title: "A", content: "snippet", raw_content: "x".repeat(500), score: 0.9 }], usage: { credits: 1 } });
    }, keys);
    const r = await data.web.search("q", { limit: 2, content: true, maxCharacters: 100 });
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.provenance.source, "tavily");
    assert.equal(r.provenance.requestId, "t1");
    const first = (r.data as unknown as { results: Array<Record<string, unknown>> }).results[0]!;
    assert.deepEqual({ ...first, content: (first.content as string).length }, { url: "https://a.example/x", title: "A", snippet: "snippet", content: 100, truncated: true, score: 0.9 });
    assert.deepEqual((r.data as { usage: unknown }).usage, { credits: 1 });
  });

  it("falls back to Exa when Tavily is out of credits (432), recorded; --provider pins one provider", async () => {
    const { data, calls } = make((url) => {
      if (url.hostname === "api.tavily.com") return json({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432);
      if (url.hostname === "api.exa.ai") return json({ requestId: "e1", results: [{ url: "https://b.example", title: "B", text: "body" }], costDollars: { total: 0.005 } });
      return assert.fail(url.href);
    }, keys);
    const r = await data.web.search("q");
    assert.ok(isLive(r), JSON.stringify(r));
    assert.equal(r.provenance.source, "exa");
    assert.match(r.provenance.fallbackFrom?.[0]?.error ?? "", /Tavily HTTP 432/);
    assert.deepEqual((r.data as { usage: unknown }).usage, { costUsd: 0.005 });
    const pinned = await data.web.search("other", { provider: "tavily" });
    assert.equal(pinned.status === "ERROR" && pinned.code, "RATE_LIMITED");
    assert.ok(calls.filter((c) => c.includes("api.exa.ai")).length === 1, "pinned request did not use exa");
  });

  it("extracts with Firecrawl one scrape per URL, keeping partial failures explicit", async () => {
    const { data } = make((url, _init, body) => {
      assert.equal(url.href, "https://api.firecrawl.dev/v2/scrape");
      if (body.url === "https://ok.example/") return json({ success: true, data: { markdown: "# Ok", metadata: { title: "Ok", statusCode: 200, sourceURL: "https://ok.example/", creditsUsed: 1 } } });
      return json({ success: false, error: "Site not reachable" }, 500);
    }, { FIRECRAWL_API_KEY: keys.FIRECRAWL_API_KEY });
    const r = await data.web.extract(["https://ok.example/", "https://down.example/"]);
    assert.ok(isLive(r), JSON.stringify(r));
    const d = r.data as { pages: Array<{ url: string; content: string }>; failed: Array<{ url: string }>; usage: unknown };
    assert.deepEqual(d.pages.map((p) => [p.url, p.content]), [["https://ok.example/", "# Ok"]]);
    assert.deepEqual(d.failed.map((f) => f.url), ["https://down.example/"]);
    assert.deepEqual(d.usage, { credits: 1 });
  });

  it("refuses non-public target URLs before any provider is asked", async () => {
    const { data, calls } = make(() => assert.fail("no request"), keys);
    for (const url of ["http://localhost:8080/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://[::ffff:10.0.0.1]/", "http://10.1.2.3/", "file:///etc/passwd", "https://user:pw@example.com/", "http://printer.local/", "ftp://example.com/"]) {
      const r = await data.web.extract(url);
      assert.equal(r.status === "ERROR" && r.code, "INVALID_INPUT", url);
    }
    for (const r of [await data.web.search(""), await data.web.search("q", { limit: 50 }), await data.web.map("http://192.168.1.1/"), await data.web.search("q", { includeDomains: ["bad domain"] })]) {
      assert.equal(r.status === "ERROR" && r.code, "INVALID_INPUT");
    }
    assert.equal(calls.length, 0);
  });

  it("answers with citations; a missing answer is 'no data', never invented", async () => {
    const ok = make(() => json({ answer: "4663", results: [{ url: "https://docs.example/chain", title: "Docs" }] }), keys);
    const a = await ok.data.web.answer("chain id?");
    assert.ok(isLive(a));
    assert.deepEqual(a.data, { query: "chain id?", answer: "4663", citations: [{ url: "https://docs.example/chain", title: "Docs" }] });
    const none = make((url) => (url.hostname === "api.tavily.com" ? json({ results: [] }) : json({ answer: "", citations: [] })), keys);
    const b = await none.data.web.answer("unknowable?");
    assert.equal(b.status, "UNAVAILABLE");
  });

  it("checks keys without spending credits (Tavily usage, Exa validation request, Firecrawl credit usage)", async () => {
    const { data, calls } = make((url, init) => {
      if (url.href === "https://api.tavily.com/usage") return json({ account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000 } });
      if (url.href === "https://api.exa.ai/search") {
        assert.equal(init?.body, "{}");
        return json({ error: "Validation error: query required", tag: "INVALID_REQUEST_BODY" }, 400);
      }
      if (url.href === "https://api.firecrawl.dev/v2/team/credit-usage") return json({ success: true, data: { remainingCredits: 990, planCredits: 1000 } });
      return json({}, 500);
    }, keys);
    const rows = await data.providers.check();
    for (const name of ["tavily", "exa", "firecrawl"]) assert.equal(rows.find((r) => r.provider === name)?.status, "healthy", name);
    assert.match(rows.find((r) => r.provider === "exa")?.detail ?? "", /no search performed/);
    assert.ok(!calls.some((c) => c.includes("/search") && c.includes("tavily")));
  });
});

describe("provider configuration", () => {
  it("does not treat routing configuration as secrets (no over-redaction)", () => {
    const env = loadProviderEnv({ env: { AI_PROVIDER: "openrouter", AI_DEFAULT_MODEL: "openai/gpt-4o-mini", GITHUB_API_VERSION: "2022-11-28", OPENROUTER_API_KEY: OR_KEY, GITHUB_TOKEN: GH_TOKEN }, file: null });
    assert.ok(env.secrets.includes(OR_KEY) && env.secrets.includes(GH_TOKEN));
    for (const pub of ["openrouter", "openai/gpt-4o-mini", "2022-11-28"]) assert.ok(!env.secrets.includes(pub), pub);
  });

  it("only contacts each provider's own host (network guard allowlist)", async () => {
    const http = new HttpClient({ hosts: ["raw.githubusercontent.com"], secrets: [] });
    await assert.rejects(http.text("https://api.github.com/user"), /blocked by the Splice network guard/);
    await assert.rejects(http.text("https://127.0.0.1/"), /blocked by the Splice network guard/);
    await assert.rejects(http.text("https://[::ffff:7f00:1]/"), /blocked by the Splice network guard/);
  });
});
