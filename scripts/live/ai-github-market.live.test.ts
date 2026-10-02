/**
 * Live integration tests for the AI, GitHub and market providers: real requests with the
 * configured credentials (.env.local / .env / process env) and real public endpoints. Nothing is
 * mocked; repositories, pairs, pools and tokens are discovered at run time (search / trending /
 * listings), and results are cross-checked between APIs where two describe the same object.
 *
 *   npm run test:live
 *
 * AI calls are billed by OpenRouter (a few short completions, fractions of a cent).
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceData, isLive, loadProviderEnv } from "../../packages/data/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = loadProviderEnv({ cwd: ROOT });
const data = new SpliceData({ cwd: ROOT });
const seen: unknown[] = [];
const summary: string[] = [];
const keep = <T>(r: T): T => (seen.push(r), r);
const note = (s: string) => summary.push(s);
const live = (r: any, label: string) => {
  keep(r);
  assert.ok(isLive(r), `${label}: ${r.status} ${r.code ?? ""} ${r.message ?? r.reason ?? ""}`);
  note(`${label}: ${r.status} via ${r.provenance.source}${r.provenance.resource ? ` (${r.provenance.resource.slice(0, 80)})` : ""}`);
  return r;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * GeckoTerminal's free API allows 10 calls/min (shared per IP). When a step is RATE_LIMITED, wait
 * for the window and ask once more — the limit is recorded in the summary, never papered over.
 */
async function patient<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const first = await fn();
  if ((first as { code?: string }).code !== "RATE_LIMITED") return first;
  note(`${label}: RATE_LIMITED by the provider/client limit — waited 61 s and retried once`);
  await sleep(61_000);
  return fn();
}

after(() => {
  const text = JSON.stringify(seen);
  for (const secret of env.secrets) assert.ok(!text.includes(secret), "a provider secret leaked into a result");
  console.log(`\nLIVE SUMMARY (AI / GitHub / market)\n${summary.map((s) => `  ${s}`).join("\n")}\n`);
});

describe("provider health (live checks)", { timeout: 120_000 }, () => {
  it("checks every new provider with a lightweight request", async () => {
    const rows = keep(await data.providers.check());
    for (const name of ["openrouter", "gemini", "github", "github-public", "github-raw", "dexscreener", "geckoterminal"]) {
      const r = rows.find((x) => x.provider === name)!;
      note(`health ${name}: ${r.status}${r.detail ? ` — ${r.detail}` : r.lastError ? ` — ${r.lastError}` : ""}`);
      if (r.configured) assert.equal(r.status, "healthy", `${name}: ${r.lastError}`);
      else assert.equal(r.status, "not_configured");
    }
  });
});

describe("OpenRouter (live)", { timeout: 240_000 }, () => {
  const configured = Boolean(env.values.OPENROUTER_API_KEY);

  it("lists real models including the configured default", { skip: !configured && "OPENROUTER_API_KEY not set" }, async () => {
    const r = live(await data.ai.models(), "ai.models");
    assert.ok(r.data.count > 50);
    if (env.values.AI_DEFAULT_MODEL) assert.ok(r.data.models.some((m: { id: string }) => m.id === env.values.AI_DEFAULT_MODEL), "default model is listed");
    note(`ai.models: ${r.data.count} models`);
  });

  it("returns a real completion with usage metadata and attribution", { skip: !configured && "OPENROUTER_API_KEY not set" }, async () => {
    const r = live(await data.ai.generate({ prompt: "Reply with exactly the word: pong", maxTokens: 10, temperature: 0 }), "ai.generate");
    assert.match(r.data.text ?? "", /pong/i);
    assert.ok((r.data.usage?.promptTokens ?? 0) > 0 && (r.data.usage?.completionTokens ?? 0) > 0, JSON.stringify(r.data.usage));
    assert.ok(r.data.model && r.data.routing.actualProvider === "openrouter" && r.data.routing.fallback === false);
    assert.ok(r.provenance.requestId);
    note(`ai.generate: "${r.data.text}" model=${r.data.model} upstream=${r.data.upstreamProvider} tokens=${r.data.usage?.totalTokens} cost=${r.data.usage?.costUsd}`);
  });

  it("calls a tool", { skip: !configured && "OPENROUTER_API_KEY not set" }, async () => {
    const r = live(
      await data.ai.generate({
        prompt: "What is the weather in Jakarta? Use the tool.",
        tools: [{ name: "get_weather", description: "Current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
        toolChoice: "required",
        maxTokens: 50,
      }),
      "ai.tools",
    );
    const call = r.data.toolCalls?.[0];
    assert.equal(call?.name, "get_weather");
    assert.match(String(JSON.parse(call!.arguments).city), /jakarta/i);
    note(`ai.tools: ${call!.name}(${call!.arguments})`);
  });

  it("returns structured output matching a schema", { skip: !configured && "OPENROUTER_API_KEY not set" }, async () => {
    const r = live(
      await data.ai.generate({
        prompt: "Give the capital city and country code of France.",
        responseSchema: { name: "capital", schema: { type: "object", properties: { city: { type: "string" }, countryCode: { type: "string" } }, required: ["city", "countryCode"], additionalProperties: false } },
        maxTokens: 50,
        temperature: 0,
      }),
      "ai.structured_output",
    );
    assert.equal((r.data.structured as { city: string }).city, "Paris");
    note(`ai.structured_output: ${JSON.stringify(r.data.structured)}`);
  });

  it("accepts image input", { skip: !configured && "OPENROUTER_API_KEY not set" }, async () => {
    // The GitHub logo/avatar of the "github" organisation (a public image URL).
    const r = live(await data.ai.generate({ messages: [{ role: "user", content: [{ type: "text", text: "In at most five words, what is shown in this image?" }, { type: "image_url", url: "https://avatars.githubusercontent.com/u/9919?s=128&v=4" }] }], maxTokens: 20 }), "ai.multimodal");
    assert.ok((r.data.text ?? "").length > 0);
    note(`ai.multimodal: "${r.data.text}"`);
  });
});

describe("Gemini (live when configured)", { timeout: 120_000 }, () => {
  it("is reported honestly", async () => {
    if (!env.values.GEMINI_API_KEY) {
      const r = keep(await data.ai.generate({ prompt: "ping", provider: "gemini", model: "gemini-2.5-flash" }));
      assert.equal(r.status, "UNAVAILABLE");
      assert.equal(data.registry.healthOf("gemini").status, "not_configured");
      return void note("gemini: not_configured (GEMINI_API_KEY not set) → UNAVAILABLE, no request made");
    }
    const models = live(await data.ai.models({ provider: "gemini" }), "gemini models");
    const model = env.values.GEMINI_DEFAULT_MODEL;
    assert.ok(model, "GEMINI_DEFAULT_MODEL is set");
    assert.ok(models.data.models.some((m: { id: string }) => m.id === model), "default Gemini model is listed");
    const r = live(await data.ai.generate({ prompt: "Reply with exactly the word: pong", provider: "gemini", maxTokens: 256 }), "gemini generate");
    assert.match(r.data.text ?? "", /pong/i);
    assert.equal(r.data.routing.actualProvider, "gemini");
    assert.ok((r.data.usage?.totalTokens ?? 0) > 0);
    const t = live(await data.ai.generate({ provider: "gemini", prompt: "What is the weather in Jakarta? Use the tool.", tools: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }], toolChoice: "required", maxTokens: 512 }), "gemini tools");
    assert.equal(t.data.toolCalls?.[0]?.name, "get_weather");
    const s = live(await data.ai.generate({ provider: "gemini", prompt: "Give the capital city and country code of France.", responseSchema: { name: "capital", schema: { type: "object", properties: { city: { type: "string" }, countryCode: { type: "string" } }, required: ["city", "countryCode"] } }, maxTokens: 512 }), "gemini structured");
    assert.equal((s.data.structured as { city: string }).city, "Paris");
    note(`gemini: ${models.data.count} models; "${r.data.text}" (${r.data.model}, ${r.data.usage?.totalTokens} tokens); tool ${t.data.toolCalls?.[0]?.name}(${t.data.toolCalls?.[0]?.arguments}); structured ${JSON.stringify(s.data.structured)}`);
  });
});

describe("GitHub (live)", { timeout: 240_000 }, () => {
  let repo = "";
  let file: { path: string; content: string; downloadUrl: string } | null = null;

  it("searches repositories (real results with totals)", async () => {
    const r = live(await data.github.searchRepositories("language:typescript stars:>20000", { perPage: 5 }), "github search");
    assert.ok(r.data.totalCount > 0 && r.data.items.length > 0);
    repo = r.data.items[0].fullName;
    note(`github search: total=${r.data.totalCount}; using ${repo}`);
  });

  it("gets the repository, its root contents, a file, commits, branches and releases", async () => {
    const meta = live(await data.github.repository(repo), "github repo");
    assert.equal(meta.data.fullName.toLowerCase(), repo.toLowerCase());
    const root = live(await data.github.contents(repo, ""), "github contents /");
    assert.equal(root.data.type, "directory");
    const entry = root.data.entries.find((e: { type: string; size: number; name: string }) => e.type === "file" && e.size > 0 && e.size < 200_000 && /\.(md|json|ts|js|txt|yml)$/i.test(e.name));
    assert.ok(entry, "a small text file in the root");
    const f = live(await data.github.contents(repo, entry.path), "github contents file");
    assert.equal(f.data.sha, entry.sha);
    file = { path: entry.path, content: f.data.content, downloadUrl: f.data.downloadUrl };
    live(await data.github.commits(repo, { perPage: 3 }), "github commits");
    live(await data.github.branches(repo, { perPage: 3 }), "github branches");
    const rel = keep(await data.github.releases(repo, { perPage: 3 }));
    assert.ok(isLive(rel), JSON.stringify(rel));
    note(`github releases: ${(rel as any).data.items.length} on page 1`);
    note(`github repo ${repo}: stars=${meta.data.stars} default=${meta.data.defaultBranch}; file ${entry.path} (${entry.size} bytes)`);
  });

  it("fetches the same file from raw.githubusercontent.com and it matches the contents API", async () => {
    assert.ok(file?.downloadUrl?.startsWith("https://raw.githubusercontent.com/"), file?.downloadUrl);
    const raw = live(await data.github.raw(file!.downloadUrl), "github raw");
    assert.equal(raw.data.content, file!.content, "raw content equals the decoded contents API content");
    note(`github raw: ${raw.data.size} bytes, identical to the contents API`);
  });

  it("uses the token where configured (user, code search) and the public API without it", async () => {
    if (env.values.GITHUB_TOKEN) {
      const me = live(await data.github.user(), "github user");
      note(`github user: ${me.data.login}`);
      const code = live(await data.github.searchCode("createGuardedFetch language:typescript", { perPage: 3 }), "github code search");
      assert.ok(code.data.totalCount >= 0);
      assert.equal(code.provenance.source, "github");
    }
    const values = { ...env.values, GITHUB_TOKEN: "" };
    const anonymous = new SpliceData({ env: values as NodeJS.ProcessEnv, envFile: null });
    const pub = live(await anonymous.github.repository(repo), "github public repo");
    assert.equal(pub.provenance.source, "github-public");
    const code = keep(await anonymous.github.searchCode("fetch"));
    assert.equal(code.status, "UNAVAILABLE", "code search is not offered anonymously");
  });
});

describe("DexScreener and GeckoTerminal (live)", { timeout: 600_000 }, () => {
  let rh: { pair: string; token: string } | null = null;

  it("DexScreener: search, pair and token pairs on Robinhood Chain", async () => {
    const s = live(await data.market.search("robinhood"), "dexscreener search");
    const p = s.data.pairs.find((x: { network: string }) => x.network === "robinhood");
    assert.ok(p, "a Robinhood pair in the search results");
    rh = { pair: p.pairAddress, token: p.baseToken.address };
    const pair = live(await data.market.pair("robinhood", rh.pair), "dexscreener pair");
    assert.equal(pair.data.pairAddress.toLowerCase(), rh.pair.toLowerCase());
    assert.equal(pair.provenance.chainId, 4663);
    const pairs = live(await data.market.pairs("robinhood", rh.token), "token pairs");
    assert.ok(pairs.data.pairs.length > 0);
    note(`dexscreener robinhood: pair ${rh.pair} ${pair.data.baseToken?.symbol}/${pair.data.quoteToken?.symbol} priceUsd=${pair.data.priceUsd} liquidityUsd=${pair.data.liquidityUsd}`);
  });

  it("GeckoTerminal: networks list includes robinhood; pool, OHLCV and trades of a discovered pool", async () => {
    const nets = live(await patient("geckoterminal networks", () => data.market.networks()), "geckoterminal networks");
    assert.ok(nets.data.networks.some((n: { id: string }) => n.id === "robinhood"));
    const trending = live(await patient("geckoterminal trending", () => data.market.trendingPools("robinhood")), "geckoterminal trending robinhood");
    const pool = trending.data.pools[0]?.pairAddress ?? rh?.pair;
    assert.ok(pool, "a Robinhood pool");
    const ohlcv = live(await patient("geckoterminal ohlcv", () => data.market.ohlcv("robinhood", pool, { timeframe: "day", limit: 5 })), "geckoterminal ohlcv");
    assert.ok(Array.isArray(ohlcv.data.candles));
    const trades = live(await patient("geckoterminal trades", () => data.market.trades("robinhood", pool)), "geckoterminal trades");
    note(`geckoterminal robinhood pool ${pool}: ${ohlcv.data.candles.length} candles, ${trades.data.trades.length} trades`);
  });

  it("each provider answers separately for the same token (quotes), never merged", async () => {
    assert.ok(rh);
    const q = keep(await patient("quotes", async () => { const r = (await data.market.quotes("robinhood", rh!.token)) as any; return Object.values(r.sections).some((s: any) => s.code === "RATE_LIMITED") ? { ...r, code: "RATE_LIMITED" } : r; })) as any;
    for (const [name, section] of Object.entries(q.sections) as Array<[string, any]>) {
      note(`quotes ${name}: ${section.status}${isLive(section) ? ` via ${section.provenance.source}` : ` ${section.code}: ${section.reason ?? section.message}`}`);
      if (isLive(section)) assert.equal(section.provenance.source, name === "price" ? section.provenance.source : name);
    }
    assert.ok(Object.values(q.sections).some((s: any) => isLive(s)));
  });

  it("other networks work with provider ids; unknown networks are UNAVAILABLE (never another chain)", async () => {
    const eth = live(await patient("geckoterminal trending eth", () => data.market.trendingPools("eth")), "geckoterminal trending eth");
    const pool = eth.data.pools[0];
    assert.ok(pool?.baseToken?.address);
    const price = live(await patient("geckoterminal token price", () => data.market.tokenPrice("eth", pool.baseToken.address)), "geckoterminal token price eth");
    assert.equal(price.provenance.source, "geckoterminal");
    note(`token price eth ${pool.baseToken.symbol}: ${price.data.price} USD`);
    const unknown = keep(await data.market.pairs("notachain", pool.baseToken.address));
    assert.equal(unknown.status, "UNAVAILABLE");

  });
});
