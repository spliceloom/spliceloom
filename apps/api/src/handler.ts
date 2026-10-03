/**
 * Public API behind spliceloom.com (api.spliceloom.com): live Robinhood Chain data, the $SPLICE token
 * read from the chain, and a rate-limited Ask endpoint over Splice's research agent.
 *
 * Platform-neutral (Web-standard Request/Response); the Cloudflare Worker adapter is worker.ts.
 * Every value comes from a provider result with its status and provenance; nothing is invented.
 * The public pages use keyless sources only (DefiLlama, GeckoTerminal, Lighter, public RPC/Blockscout),
 * so page traffic never spends a paid provider quota.
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

export async function tokenSummary(data: SpliceData): Promise<Record<string, unknown>> {
  const [token, market, ...burns] = await Promise.all([
    data.onchain.token(TOKEN_CA),
    data.market.token("robinhood", TOKEN_CA),
    ...BURN_ADDRESSES.map((a) => data.onchain.call(TOKEN_CA, BALANCE_OF + pad32(a))),
  ]);
  const sections = "sections" in token ? (token.sections as Record<string, DataResult<any>>) : {};
  const meta = live<{ name?: string; symbol?: string; decimals?: number }>(sections.metadata);
  const supply = live<{ raw: string; formatted: string }>(sections.totalSupply);
  const holders = live<{ holdersCount?: string }>(sections.holders);
  const decimals = meta?.decimals ?? 18;
  const burnRows = BURN_ADDRESSES.map((address, i) => {
    const r = live<{ result: string }>(burns[i]);
    return { address, raw: r ? BigInt(r.result) : undefined, section: section(burns[i]) };
  });
  const burnedRaw = burnRows.every((b) => b.raw !== undefined) ? burnRows.reduce((s, b) => s + b.raw!, 0n) : undefined;
  const supplyRaw = supply ? BigInt(supply.raw) : undefined;
  const m = live<{ priceUsd?: string; fdvUsd?: string; totalReserveUsd?: string; volumeUsd?: { h24?: string } }>(market);
  return {
    address: TOKEN_CA,
    chain: "robinhood",
    chainId: 4663,
    name: meta?.name ?? null,
    symbol: meta?.symbol ?? null,
    decimals,
    totalSupply: supply?.formatted ?? null,
    holders: holders?.holdersCount ?? null,
    burned: {
      total: burnedRaw !== undefined ? formatUnits(burnedRaw, decimals) : null,
      pctOfSupply: burnedRaw !== undefined && supplyRaw ? Number((burnedRaw * 1_000_000n) / supplyRaw) / 10_000 : null,
      addresses: burnRows.map((b) => ({ address: b.address, amount: b.raw !== undefined ? formatUnits(b.raw, decimals) : null, ...b.section })),
    },
    market: m ? { priceUsd: m.priceUsd ?? null, fdvUsd: m.fdvUsd ?? null, liquidityUsd: m.totalReserveUsd ?? null, volume24hUsd: m.volumeUsd?.h24 ?? null } : null,
    sources: {
      metadata: section(sections.metadata),
      totalSupply: section(sections.totalSupply),
      holders: section(sections.holders),
      burned: burnRows[0]!.section,
      market: section(market),
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
      if (request.method === "GET" && url.pathname === "/v1/token") return json(await tokenSummary(options.data()), 200, origin, { "cache-control": "public, max-age=60" });
      if (request.method === "GET" && url.pathname === "/v1/chain") return json(await chainSummary(options.data()), 200, origin, { "cache-control": "public, max-age=300" });
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
