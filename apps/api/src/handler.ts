/**
 * Public API behind spliceloom.com (api.spliceloom.com): live Robinhood Chain data, the $SPLICE token
 * read from the chain, and a rate-limited Ask endpoint over Splice's research agent.
 *
 * Platform-neutral (Web-standard Request/Response); the Cloudflare Worker adapter is worker.ts.
 * Every value comes from a provider result with its status and provenance; nothing is invented.
 * Paid quotas are protected: the token page reads Codex through a global cache refreshed at most every
 * 20 minutes; everything else on it comes from the chain (RPC, Blockscout) and Chainlink.
 */
import { isLive, type AiMessage, type Composite, type DataResult, type SpliceData } from "@spliceloom/data";
import { agentSystemPrompt, runAgentTurn } from "@spliceloom/mcp/agent";

/** The official $SPLICE contract on Robinhood Chain (announced on spliceloom.com and @spliceloom). */
export const TOKEN_CA = "0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806";
const BURN_ADDRESSES = ["0x000000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000000000"];
const BALANCE_OF = "0x70a08231";

export const MAX_QUESTION = 300;
/** Tools the public Ask endpoint withholds: web and GitHub (untrusted third-party content, paid quotas). */
const ASK_EXCLUDED = ["web_search", "web_extract", "web_map", "web_similar", "web_answer", "github_repository", "github_search_repositories", "github_contents", "github_commits", "github_releases", "github_raw"];

export interface Counters {
  /** Increments `key` (expiring at `expiresAt`, ms) and returns the new value. */
  increment(key: string, expiresAt: number): Promise<number>;
}

export interface ApiOptions {
  data: () => SpliceData;
  counters?: Counters;
  /** Origins allowed to call the API from a browser. */
  origins: string[];
  askDailyLimit?: number;
  askPerClientDaily?: number;
  /** Coarse per-client burst limiter (Workers Rate Limiting binding); false = limited. */
  burst?: (client: string) => Promise<boolean>;
  askModel?: string;
  now?: () => Date;
  /** Global JSON cache and background tasks (token market data). */
  cache?: JsonCache;
  background?: (task: Promise<unknown>) => void;
}

type Section = { status: string; source?: string; fetchedAt?: string; reason?: string };

function section(r: DataResult<unknown> | Composite | { status: string } | undefined): Section {
  if (!r) return { status: "UNAVAILABLE" };
  const x = r as { status?: string; provenance?: { source?: string; fetchedAt?: string }; reason?: string; message?: string };
  const out: Section = { status: x.status ?? "LIVE" };
  if (x.provenance?.source) out.source = x.provenance.source;
  if (x.provenance?.fetchedAt) out.fetchedAt = x.provenance.fetchedAt;
  if (x.reason) out.reason = x.reason;
  else if (x.message) out.reason = x.message;
  return out;
}

const live = <T>(r: unknown): T | undefined => (r && isLive(r as DataResult<T>) ? (r as { data: T }).data : undefined);

/** Formats a raw integer amount with `decimals` as a decimal string (no float rounding). */
export function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const pad32 = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The main $SPLICE pool (SPLICE / WETH, constant-product pair on pons-v2). */
export const TOKEN_POOL = "0x9f9149e9aad34b75e77f0ae1023f8734706ca47e";
const GET_RESERVES = "0x0902f1ac";

/** Global cache shared by every data center (D1 in the Worker). */
export interface JsonCache {
  get(key: string): Promise<{ value: unknown; at: number } | null>;
  set(key: string, value: unknown, at: number): Promise<void>;
}

export interface CacheContext {
  cache?: JsonCache;
  /** Runs a background refresh after the response is sent (Worker ctx.waitUntil). */
  background?: (task: Promise<unknown>) => void;
  now?: () => number;
}

/**
 * Stale-while-revalidate: a fresh entry is returned as is; a stale one is returned and refreshed in
 * the background; a missing one is fetched. `keep` decides whether a fetched value may be cached.
 */
export async function cachedJson<T>(ctx: CacheContext, key: string, freshMs: number, fetch: () => Promise<T>, keep: (value: T) => boolean): Promise<{ value: T; at: number }> {
  const now = ctx.now ?? Date.now;
  const entry = ctx.cache ? await ctx.cache.get(key).catch(() => null) : null;
  const refresh = async () => {
    const value = await fetch();
    const at = now();
    if (ctx.cache && keep(value)) await ctx.cache.set(key, value, at).catch(() => undefined);
    return { value, at };
  };
  if (entry && now() - entry.at < freshMs) return entry as { value: T; at: number };
  if (entry && ctx.background) {
    ctx.background(refresh().catch(() => undefined));
    return entry as { value: T; at: number };
  }
  return refresh();
}

/** Codex market data for the token: refreshed at most every 20 minutes (free plan: 10,000 requests/month). */
export const CODEX_TTL_MS = 20 * 60_000;

async function codexMarket(data: SpliceData) {
  const [resolved, chart, trades] = await Promise.all([data.tokens.resolve(TOKEN_CA), data.tokens.chart(TOKEN_CA, { timeframe: "5m", limit: 500 }), data.tokens.trades(TOKEN_CA, { limit: 25 })]);
  const stats = "stats" in resolved ? resolved.stats : undefined;
  const candles = live<{ candles: Array<{ time: string; open: string; high: string; low: string; close: string; volumeUsd?: string }> }>(chart)?.candles ?? [];
  // 5-minute OHLCV candles: [unix seconds, open, high, low, close, volume USD].
  const points = candles.map((c) => [Math.floor(Date.parse(c.time) / 1000), Number(c.open), Number(c.high), Number(c.low), Number(c.close), Number(c.volumeUsd ?? 0)] as const);
  const tradeRows = live<{ trades: Array<{ type: string; time: string; txHash?: string; maker?: string; priceUsd?: string; valueUsd?: string }> }>(trades)?.trades ?? [];
  return {
    stats: stats
      ? { priceUsd: stats.priceUsd ?? null, changePct: stats.changePct, volumeUsd: stats.volumeUsd, liquidityUsd: stats.liquidityUsd ?? null, marketCapUsd: stats.marketCapUsd ?? null, holders: stats.holders ?? null, txns24: stats.txns24 ?? null, buys24: stats.buys24 ?? null, sells24: stats.sells24 ?? null, uniqueBuyers24: stats.uniqueBuyers24 ?? null, uniqueSellers24: stats.uniqueSellers24 ?? null, createdAt: stats.createdAt ?? null }
      : null,
    chart: points,
    trades: tradeRows.map((t) => ({ type: t.type, time: t.time, txHash: t.txHash ?? null, maker: t.maker ?? null, priceUsd: t.priceUsd ?? null, valueUsd: t.valueUsd ?? null })),
    sources: { stats: "stats" in resolved ? { status: stats ? "LIVE" : "UNAVAILABLE", source: "codex", fetchedAt: new Date().toISOString() } : section(resolved as DataResult<unknown>), chart: section(chart), trades: section(trades) },
  };
}

/** pons-v2 pair events: Buy (ETH in, SPLICE out) and Sell (SPLICE in, ETH out); data words 0 and 1 are the amounts. */
const BUY_TOPIC = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const SELL_TOPIC = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
/** getLogs is limited to 2,000 blocks (about 3 minutes on Robinhood Chain). */
const LIVE_BLOCKS = 1999;

/** Live price from the pool reserves and the swaps of the last ~2,000 blocks, all read from the chain. */
export async function tokenLive(data: SpliceData, ctx: CacheContext = {}): Promise<Record<string, unknown>> {
  const head = await data.onchain.latestBlock({ fresh: true });
  const block = live<{ number: string | number; timestamp: string | number }>(head);
  if (!block) return { status: "UNAVAILABLE", reason: section(head).reason ?? "no block" };
  const n = Number(block.number);
  const [reserves, poolBalance, eth, logs] = await Promise.all([
    data.onchain.call(TOKEN_POOL, GET_RESERVES, { fresh: true }),
    data.onchain.call(TOKEN_CA, BALANCE_OF + pad32(TOKEN_POOL), { fresh: true }),
    cachedJson(ctx, "eth:usd:v1", 60_000, async () => live<{ price: string }>(await data.oracle.price("ETH"))?.price ?? null, (v) => v !== null),
    data.onchain.logs({ address: TOKEN_POOL, fromBlock: Math.max(0, n - LIVE_BLOCKS), toBlock: n }, { fresh: true }),
  ]);
  const ethUsd = Number(eth.value ?? NaN);
  const res = live<{ result: string }>(reserves)?.result;
  const bal = live<{ result: string }>(poolBalance)?.result;
  let priceEth: number | null = null;
  let wethAmount: number | null = null;
  if (res && res.length >= 130 && bal) {
    const r0 = BigInt(`0x${res.slice(2, 66)}`);
    const r1 = BigInt(`0x${res.slice(66, 130)}`);
    const balance = BigInt(bal);
    const [splice, weth] = r1 === balance || (r0 !== balance && r1 > r0) ? [r1, r0] : [r0, r1];
    wethAmount = Number(weth) / 1e18;
    priceEth = Number(splice) > 0 ? wethAmount / (Number(splice) / 1e18) : null;
  }
  const raw = live<{ logs: Array<{ topics: string[]; data: string; blockNumber: string | number; transactionHash: string; logIndex: string | number }> }>(logs)?.logs ?? [];
  const swapLogs = raw.filter((l) => l.topics[0] === BUY_TOPIC || l.topics[0] === SELL_TOPIC).slice(-30);
  const blocks = [...new Set(swapLogs.map((l) => Number(l.blockNumber)))].slice(-12);
  const times = new Map<number, number>();
  await Promise.all(
    blocks.map(async (b) => {
      const r = live<{ timestamp: string | number }>(await data.onchain.block(b));
      if (r) times.set(b, Number(r.timestamp));
    }),
  );
  const word = (d: string, i: number) => BigInt(`0x${d.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"}`);
  const swaps = swapLogs
    .map((l) => {
      const buy = l.topics[0] === BUY_TOPIC;
      const ethAmt = Number(buy ? word(l.data, 0) : word(l.data, 1)) / 1e18;
      const spliceAmt = Number(buy ? word(l.data, 1) : word(l.data, 0)) / 1e18;
      const ts = times.get(Number(l.blockNumber));
      return {
        type: buy ? "Buy" : "Sell",
        splice: spliceAmt,
        eth: ethAmt,
        valueUsd: Number.isFinite(ethUsd) ? ethAmt * ethUsd : null,
        priceUsd: spliceAmt > 0 && Number.isFinite(ethUsd) ? (ethAmt / spliceAmt) * ethUsd : null,
        wallet: l.topics[2] ? `0x${l.topics[2].slice(-40)}` : null,
        txHash: l.transactionHash,
        block: Number(l.blockNumber),
        logIndex: Number(l.logIndex),
        time: ts !== undefined ? new Date(ts * 1000).toISOString() : null,
      };
    })
    .reverse();
  return {
    status: "LIVE",
    block: n,
    time: new Date(Number(block.timestamp) * 1000).toISOString(),
    priceEth,
    ethUsd: Number.isFinite(ethUsd) ? ethUsd : null,
    priceUsd: priceEth !== null && Number.isFinite(ethUsd) ? priceEth * ethUsd : null,
    liquidityUsd: wethAmount !== null && Number.isFinite(ethUsd) ? 2 * wethAmount * ethUsd : null,
    swaps,
    window: { fromBlock: Math.max(0, n - LIVE_BLOCKS), toBlock: n },
    sources: { pool: section(reserves), swaps: section(logs), ethUsd: { status: Number.isFinite(ethUsd) ? "LIVE" : "UNAVAILABLE", source: "chainlink-candlestick", fetchedAt: new Date(eth.at).toISOString() } },
  };
}

export async function tokenSummary(data: SpliceData, ctx: CacheContext = {}): Promise<Record<string, unknown>> {
  const [token, reserves, poolBalance, eth, market, ...burns] = await Promise.all([
    data.onchain.token(TOKEN_CA),
    data.onchain.call(TOKEN_POOL, GET_RESERVES),
    data.onchain.call(TOKEN_CA, BALANCE_OF + pad32(TOKEN_POOL)),
    data.oracle.price("ETH"),
    cachedJson(ctx, "codex:token:v3", CODEX_TTL_MS, () => codexMarket(data), (v) => v.stats !== null),
    ...BURN_ADDRESSES.map((a) => data.onchain.call(TOKEN_CA, BALANCE_OF + pad32(a))),
  ]);
  const sections = "sections" in token ? (token.sections as Record<string, DataResult<any>>) : {};
  const meta = live<{ name?: string; symbol?: string; decimals?: number }>(sections.metadata);
  const supply = live<{ raw: string; formatted: string }>(sections.totalSupply);
  const holders = live<{ holdersCount?: string; top?: Array<{ address: string; value: string }> }>(sections.holders);
  const decimals = meta?.decimals ?? 18;
  const supplyRaw = supply ? BigInt(supply.raw) : undefined;
  const pct = (raw: bigint) => (supplyRaw ? Number((raw * 1_000_000n) / supplyRaw) / 10_000 : null);
  const burnRows = BURN_ADDRESSES.map((address, i) => {
    const r = live<{ result: string }>(burns[i]);
    return { address, raw: r ? BigInt(r.result) : undefined, section: section(burns[i]) };
  });
  const burnedRaw = burnRows.every((b) => b.raw !== undefined) ? burnRows.reduce((s, b) => s + b.raw!, 0n) : undefined;

  // Live price from the pool: WETH reserve / SPLICE reserve × ETH/USD (Chainlink). The SPLICE side is
  // the reserve equal to the pool's SPLICE balance (no assumption about token order).
  let pool: Record<string, unknown> | null = null;
  const res = live<{ result: string }>(reserves)?.result;
  const bal = live<{ result: string }>(poolBalance)?.result;
  const ethUsd = Number(live<{ price: string }>(eth)?.price ?? NaN);
  if (res && res.length >= 130 && bal) {
    const r0 = BigInt(`0x${res.slice(2, 66)}`);
    const r1 = BigInt(`0x${res.slice(66, 130)}`);
    const balance = BigInt(bal);
    const [splice, weth] = r1 === balance || (r0 !== balance && r1 > r0) ? [r1, r0] : [r0, r1];
    const wethAmount = Number(weth) / 1e18;
    const spliceAmount = Number(splice) / 10 ** decimals;
    const priceEth = spliceAmount > 0 ? wethAmount / spliceAmount : null;
    pool = {
      address: TOKEN_POOL,
      pair: "SPLICE / WETH",
      reserveSplice: formatUnits(splice, decimals),
      reserveWeth: formatUnits(weth, 18),
      priceEth,
      ethUsd: Number.isFinite(ethUsd) ? ethUsd : null,
      priceUsd: priceEth !== null && Number.isFinite(ethUsd) ? priceEth * ethUsd : null,
      // Both sides of a constant-product pool hold equal value at the pool price.
      liquidityUsd: Number.isFinite(ethUsd) ? 2 * wethAmount * ethUsd : null,
    };
  }
  const priceUsd = (pool?.priceUsd as number | null | undefined) ?? null;
  const supplyNum = supply ? Number(supply.formatted) : null;
  const labels: Record<string, string> = { [TOKEN_POOL]: "Liquidity pool (SPLICE / WETH)", [BURN_ADDRESSES[0]!.toLowerCase()]: "Burn address (dead)", [BURN_ADDRESSES[1]!]: "Zero address" };
  return {
    address: TOKEN_CA,
    chain: "robinhood",
    chainId: 4663,
    name: meta?.name ?? null,
    symbol: meta?.symbol ?? null,
    decimals,
    totalSupply: supply?.formatted ?? null,
    holders: holders?.holdersCount ?? null,
    priceUsd,
    fdvUsd: priceUsd !== null && supplyNum !== null ? priceUsd * supplyNum : null,
    pool,
    burned: {
      total: burnedRaw !== undefined ? formatUnits(burnedRaw, decimals) : null,
      pctOfSupply: burnedRaw !== undefined ? pct(burnedRaw) : null,
      addresses: burnRows.map((b) => ({ address: b.address, amount: b.raw !== undefined ? formatUnits(b.raw, decimals) : null, ...b.section })),
    },
    topHolders: (holders?.top ?? []).map((h) => ({ address: h.address, amount: formatUnits(BigInt(h.value), decimals), pctOfSupply: pct(BigInt(h.value)), label: labels[h.address.toLowerCase()] ?? null })),
    market: { ...market.value, updatedAt: new Date(market.at).toISOString() },
    sources: {
      metadata: section(sections.metadata),
      totalSupply: section(sections.totalSupply),
      holders: section(sections.holders),
      burned: burnRows[0]!.section,
      pool: section(reserves),
      ethUsd: section(eth),
      ...market.value.sources,
    },
  };
}
export async function chainSummary(data: SpliceData): Promise<Record<string, unknown>> {
  const [defi, gainers, losers, perps, pools, protocols] = await Promise.all([
    data.defi.overview(),
    data.stocks.movers({ kind: "gainers", limit: 5 }),
    data.stocks.movers({ kind: "losers", limit: 5 }),
    data.perps.markets({ sort: "volume", limit: 8 }),
    data.market.newPools("robinhood"),
    data.defi.protocols({ limit: 8 }),
  ]);
  const tvlResult = "sections" in defi ? (defi.sections as Record<string, DataResult<any>>).tvl : undefined;
  const tvl = live<{ tvlUsd: number; date: string; change1dPct?: number; change7dPct?: number; change30dPct?: number; history?: Array<{ date: string; tvlUsd: number }> }>(tvlResult);
  const stock = (r: unknown) =>
    (live<{ pools: Array<any> }>(r)?.pools ?? []).map((p) => ({ symbol: p.baseToken?.symbol, name: p.baseToken?.name, priceUsd: p.priceUsd, change24hPct: p.priceChangePct?.h24, volume24hUsd: p.volumeUsd?.h24, liquidityUsd: p.liquidityUsd }));
  const markets = (live<{ label?: string; markets: Array<any> }>(perps)?.markets ?? []).map((x) => ({ symbol: x.symbol, markPrice: x.markPrice, change24hPct: x.change24hPct, volume24hUsd: x.volume24hUsd, openInterestUsd: x.openInterestUsd }));
  const newest = (live<{ pools: Array<any> }>(pools)?.pools ?? []).slice(0, 8).map((p) => ({ name: p.name, dex: p.dex, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd, volume24hUsd: p.volumeUsd?.h24, createdAt: p.createdAt, url: p.url }));
  const protos = (live<{ protocols: Array<any> }>(protocols)?.protocols ?? []).map((p) => ({ name: p.name, category: p.category, tvlUsd: p.tvlOnChainUsd, change7dPct: p.change7dPct, url: p.url }));
  return {
    chain: "robinhood",
    chainId: 4663,
    tvl: tvl ? { tvlUsd: tvl.tvlUsd, date: tvl.date, change1dPct: tvl.change1dPct ?? null, change7dPct: tvl.change7dPct ?? null, change30dPct: tvl.change30dPct ?? null, history: (tvl.history ?? []).map((h) => [h.date, h.tvlUsd]) } : null,
    stocks: { gainers: stock(gainers), losers: stock(losers) },
    perps: markets,
    newPools: newest,
    protocols: protos,
    sources: {
      tvl: section(tvlResult),
      stocks: section(gainers),
      perps: section(perps),
      newPools: section(pools),
      protocols: section(protocols),
    },
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function createApiHandler(options: ApiOptions): (request: Request, client: string) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const json = (body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", vary: "Origin", ...extra };
    if (origin && options.origins.includes(origin)) headers["access-control-allow-origin"] = origin;
    return new Response(JSON.stringify(body), { status, headers });
  };

  return async (request, client) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      if (!origin || !options.origins.includes(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "Origin" } });
    }
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") return json({ ok: true }, 200, origin, { "cache-control": "no-store" });
      if (request.method === "GET" && url.pathname === "/v1/token") {
        const ctx: CacheContext = { ...(options.cache ? { cache: options.cache } : {}), ...(options.background ? { background: options.background } : {}) };
        // The whole summary is served from the global cache too, so no visitor waits for slow providers.
        const summary = await cachedJson(ctx, "token:summary:v1", 60_000, () => tokenSummary(options.data(), ctx), (v) => v.priceUsd !== null);
        return json(summary.value, 200, origin, { "cache-control": "public, max-age=30" });
      }
      if (request.method === "GET" && url.pathname === "/v1/token/live") {
        const ctx: CacheContext = { ...(options.cache ? { cache: options.cache } : {}), ...(options.background ? { background: options.background } : {}) };
        return json(await tokenLive(options.data(), ctx), 200, origin, { "cache-control": "public, max-age=4" });
      }
      if (request.method === "GET" && url.pathname === "/v1/chain") {
        const ctx: CacheContext = { ...(options.cache ? { cache: options.cache } : {}), ...(options.background ? { background: options.background } : {}) };
        const summary = await cachedJson(ctx, "chain:summary:v1", 5 * 60_000, () => chainSummary(options.data()), (v) => v.tvl !== null);
        return json(summary.value, 200, origin, { "cache-control": "public, max-age=60" });
      }
      if (url.pathname === "/v1/ask") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
        return await ask(request, client, origin);
      }
      return json({ error: "not_found" }, 404, origin);
    } catch (error) {
      return json({ error: "internal", message: "the request failed" }, 500, origin, { "cache-control": "no-store" });
    }
  };

  async function ask(request: Request, client: string, origin: string | null): Promise<Response> {
    const noStore = { "cache-control": "no-store" };
    if (!origin || !options.origins.includes(origin)) return json({ error: "forbidden", message: "Ask is available on spliceloom.com." }, 403, origin, noStore);
    let question = "";
    try {
      const body = (await request.json()) as { question?: unknown };
      if (typeof body.question === "string") question = body.question.trim();
    } catch {
      /* handled below */
    }
    if (!question) return json({ error: "invalid_input", message: "Send {\"question\": \"...\"}." }, 400, origin, noStore);
    if (question.length > MAX_QUESTION) return json({ error: "invalid_input", message: `Questions are limited to ${MAX_QUESTION} characters.` }, 400, origin, noStore);
    if (options.burst && !(await options.burst(client))) return json({ error: "rate_limited", message: "Too many questions in a short time. Wait a minute and try again." }, 429, origin, noStore);
    if (options.counters) {
      const day = now().toISOString().slice(0, 10);
      const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      const mine = await options.counters.increment(`ask:${day}:${await sha256(client)}`, tomorrow);
      if (mine > (options.askPerClientDaily ?? 10)) return json({ error: "rate_limited", message: "Daily question limit reached. Install the CLI for unlimited questions: npm install -g @spliceloom/cli" }, 429, origin, noStore);
      const all = await options.counters.increment(`ask:${day}`, tomorrow);
      if (all > (options.askDailyLimit ?? 200)) return json({ error: "rate_limited", message: "Today's free questions are used up. Install the CLI to keep asking: npm install -g @spliceloom/cli" }, 429, origin, noStore);
    }
    const messages: AiMessage[] = [
      { role: "system", content: agentSystemPrompt(now(), "the Ask box on spliceloom.com, answering visitors") },
      { role: "user", content: question },
    ];
    const t = await runAgentTurn(options.data(), messages, { maxSteps: 5, maxTokens: 900, exclude: ASK_EXCLUDED, ...(options.askModel ? { model: options.askModel } : {}) });
    if ("failure" in t || "error" in t) return json({ error: "unavailable", message: "The model is unavailable right now. Try again shortly." }, 503, origin, noStore);
    return json({ question, answer: t.answer, calls: t.calls, model: t.model ?? null, costUsd: t.costUsd }, 200, origin, noStore);
  }
}
