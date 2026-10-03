/**
 * Read-only commands for the AI, GitHub and market providers: `splice ai`, `splice github`,
 * `splice market`. Like the other live data commands, every result is printed with its status
 * (LIVE / CACHED / UNAVAILABLE / ERROR) and provenance; exit codes 0 / 3 / 1 / 2.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isLive, type AiGenerateInput, type DataResult, type WebCallOptions } from "@spliceloom/data";
import { UsageError, type Context } from "../io.js";
import { dataFor, emit, need, statusLine } from "./data.js";
import { age, pct, sparkline, table, truncate, usdCompact, usdPrice } from "../format.js";
import { stockFinnhubCommand } from "./markets.js";

export interface LiveFlags {
  fresh?: boolean;
  /** Alert targets for watch / radar: discord, telegram (comma-separated). */
  notify?: string;
  model?: string;
  provider?: string;
  system?: string;
  maxTokens?: string;
  temperature?: string;
  search?: string;
  noFallback?: boolean;
  schema?: string;
  ref?: string;
  page?: string;
  perPage?: string;
  state?: string;
  maxBytes?: string;
  vs?: string;
  timeframe?: string;
  aggregate?: string;
  limit?: string;
  maxChars?: string;
  content?: boolean;
  includeDomain?: string[];
  excludeDomain?: string[];
  session?: string;
  sort?: string;
  window?: string;
  minLiquidity?: string;
  venue?: string;
  above?: string;
  below?: string;
  change?: string;
  interval?: string;
  count?: string;
  min?: string;
}

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

function fresh(flags: LiveFlags): { fresh?: boolean } {
  return flags.fresh ? { fresh: true } : {};
}

function paging(flags: LiveFlags): { page?: number; perPage?: number } {
  const out: { page?: number; perPage?: number } = {};
  const page = int(flags.page, "page");
  const perPage = int(flags.perPage, "per-page");
  if (page !== undefined) out.page = page;
  if (perPage !== undefined) out.perPage = perPage;
  return out;
}

// --------------------------------------------------------------------------------------------- ai

export async function aiCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub, ...args] = positionals;
  const data = dataFor(ctx);
  if (sub === "models") {
    const options: { provider?: string; search?: string; fresh?: boolean } = { ...fresh(flags) };
    if (flags.provider) options.provider = flags.provider;
    if (flags.search) options.search = flags.search;
    const result = await data.ai.models(options);
    if (ctx.json || !isLive(result)) return emit(ctx, "models", result);
    const d = result.data as { provider: string; count: number; models: Array<{ id: string; contextLength?: number; pricing?: { prompt?: string; completion?: string }; supportsTools?: boolean; supportsStructuredOutput?: boolean }> };
    ctx.out(`${ctx.style.bold("models")}  ${statusLine(ctx, result)}  count=${d.count}`);
    for (const m of d.models.slice(0, 50)) {
      const price = m.pricing?.prompt ? `$${(Number(m.pricing.prompt) * 1e6).toFixed(2)}/$${(Number(m.pricing.completion ?? 0) * 1e6).toFixed(2)} per 1M` : "";
      ctx.out(`  ${m.id.padEnd(48)} ${String(m.contextLength ?? "").padStart(8)} ctx  ${price.padEnd(24)} ${m.supportsTools ? "tools " : ""}${m.supportsStructuredOutput ? "structured" : ""}`);
    }
    if (d.models.length > 50) ctx.out(ctx.style.dim(`  … ${d.models.length - 50} more (use --search or --json)`));
    return 0;
  }
  if (sub === "generate") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new UsageError("missing prompt", 'Usage: splice ai generate "<prompt>" [--model <id>] [--provider <name>] [--system <text>] [--max-tokens <n>] [--schema <file.json>]');
    const input: AiGenerateInput = { prompt };
    if (flags.model) input.model = flags.model;
    if (flags.provider) input.provider = flags.provider;
    if (flags.system) input.system = flags.system;
    if (flags.noFallback) input.fallback = false;
    const maxTokens = int(flags.maxTokens, "max-tokens");
    if (maxTokens !== undefined) input.maxTokens = maxTokens;
    if (flags.temperature !== undefined) {
      const t = Number(flags.temperature);
      if (!Number.isFinite(t)) throw new UsageError("--temperature must be a number");
      input.temperature = t;
    }
    if (flags.schema) {
      let schema: unknown;
      try {
        schema = JSON.parse(readFileSync(resolve(ctx.io.cwd, flags.schema), "utf8"));
      } catch (error) {
        throw new UsageError(`--schema: cannot read JSON schema: ${(error as Error).message}`);
      }
      input.responseSchema = { name: "response", schema: schema as Record<string, unknown> };
    }
    const result = await data.ai.generate(input);
    if (ctx.json || !isLive(result)) return emit(ctx, "ai", result);
    const d = result.data;
    ctx.out(`${ctx.style.bold("ai")}  ${statusLine(ctx, result)}`);
    ctx.out(ctx.style.dim(`  provider=${d.routing.actualProvider}${d.upstreamProvider ? ` (${d.upstreamProvider})` : ""}  model=${d.routing.actualModel}${d.routing.fallback ? `  FALLBACK from ${d.routing.requestedProvider}/${d.routing.requestedModel}: ${d.routing.fallbackReason}` : ""}`));
    if (d.structured !== undefined) ctx.out(JSON.stringify(d.structured, null, 2));
    else if (d.text) ctx.out(d.text);
    for (const t of d.toolCalls ?? []) ctx.out(`  tool call: ${t.name}(${t.arguments})`);
    const u = d.usage;
    if (u) ctx.out(ctx.style.dim(`  usage: ${u.promptTokens ?? "?"} prompt + ${u.completionTokens ?? "?"} completion tokens${u.costUsd !== undefined ? `, cost ${u.costUsd} USD` : ""}; finish=${d.finishReason ?? "-"}`));
    for (const n of result.provenance.notes ?? []) ctx.out(ctx.style.dim(`  note: ${n}`));
    return 0;
  }
  throw new UsageError(`unknown subcommand "ai ${sub ?? ""}"`, 'Usage: splice ai models [--search <q>] | splice ai generate "<prompt>" [--model <id>]');
}

// ----------------------------------------------------------------------------------------- github

export async function githubCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub, a, b] = positionals;
  const gh = dataFor(ctx).github;
  const usage = "splice github repo|contents|tree|commits|branches|releases|release|issues|pulls <owner/repo> | search|code <query> | user [login] | raw <url>";
  const opts = { ...fresh(flags), ...paging(flags) };
  const ref = flags.ref ? { ref: flags.ref } : {};
  const state = flags.state ? { state: flags.state as "open" | "closed" | "all" } : {};
  let result: DataResult<unknown>;
  switch (sub) {
    case "repo":
      result = await gh.repository(need(positionals, 1, "splice github repo <owner/repo>"), fresh(flags));
      break;
    case "search":
      result = await gh.searchRepositories(need(positionals, 1, 'splice github search "<query>"'), opts);
      break;
    case "code":
      result = await gh.searchCode(need(positionals, 1, 'splice github code "<query>"'), opts);
      break;
    case "contents":
      result = await gh.contents(need(positionals, 1, "splice github contents <owner/repo> [path] [--ref <ref>]"), b ?? "", { ...fresh(flags), ...ref });
      break;
    case "tree":
      result = await gh.tree(need(positionals, 1, "splice github tree <owner/repo> [--ref <ref>]"), { ...fresh(flags), ...ref });
      break;
    case "commits":
      result = await gh.commits(need(positionals, 1, "splice github commits <owner/repo> [path] [--ref <ref>]"), { ...opts, ...ref, ...(b ? { path: b } : {}) });
      break;
    case "branches":
      result = await gh.branches(need(positionals, 1, "splice github branches <owner/repo>"), opts);
      break;
    case "releases":
      result = await gh.releases(need(positionals, 1, "splice github releases <owner/repo>"), opts);
      break;
    case "release":
      result = await gh.release(need(positionals, 1, "splice github release <owner/repo> [tag|latest|id]"), b ?? "latest", fresh(flags));
      break;
    case "issues":
      result = await gh.issues(need(positionals, 1, "splice github issues <owner/repo> [--state open|closed|all]"), { ...opts, ...state });
      break;
    case "pulls":
      result = await gh.pullRequests(need(positionals, 1, "splice github pulls <owner/repo> [--state open|closed|all]"), { ...opts, ...state });
      break;
    case "user":
      result = await gh.user(a, fresh(flags));
      break;
    case "raw": {
      const maxBytes = int(flags.maxBytes, "max-bytes");
      result = await gh.raw(need(positionals, 1, "splice github raw <https://raw.githubusercontent.com/...>"), { ...fresh(flags), ...(maxBytes !== undefined ? { maxBytes } : {}) });
      if (!ctx.json && isLive(result)) {
        // Print the file itself on stdout and the provenance on stderr, so it can be piped.
        ctx.err(`${ctx.style.bold("raw")}  ${statusLine(ctx, result)}`);
        const content = (result.data as { content?: string }).content;
        if (content !== undefined) ctx.io.stdout(content);
        else for (const n of result.provenance.notes ?? []) ctx.err(ctx.style.dim(`note: ${n}`));
        return 0;
      }
      break;
    }
    default:
      throw new UsageError(`unknown subcommand "github ${sub ?? ""}"`, `Usage: ${usage}`);
  }
  return emit(ctx, `github ${sub}`, result);
}

// ----------------------------------------------------------------------------------------- market

interface PoolRow {
  name?: string;
  dex?: string;
  pairAddress?: string;
  baseToken?: { symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidityUsd?: string;
  volumeUsd?: Record<string, string>;
  priceChangePct?: Record<string, string>;
  transactions?: Record<string, { buys?: number; sells?: number }>;
  marketCapUsd?: string;
  fdvUsd?: string;
  createdAt?: string;
  metric?: { name: string; value: number };
}

/** Pool lists (trending, new, top, movers) as a table; --json prints the full result. */
function emitPools(ctx: Context, label: string, result: DataResult<unknown>, limit = 20): number {
  if (ctx.json || !isLive(result)) return emit(ctx, label, result);
  const d = result.data as { network?: string; pools?: PoolRow[]; formula?: string; window?: string };
  const pools = d.pools ?? [];
  const s = ctx.style;
  ctx.out(`${s.bold(label)}  ${statusLine(ctx, result)}`);
  for (const note of result.provenance.notes ?? []) ctx.out(s.dim(`  note: ${note}`));
  if (pools.length === 0) {
    ctx.out(s.dim("  (no pools returned)"));
    return 0;
  }
  const w = d.window ?? "h24";
  const rows = pools.slice(0, limit).map((p, i) => {
    const tx = p.transactions?.[w] ?? p.transactions?.h24;
    return [
      String(i + 1),
      s.bold(truncate(p.baseToken?.symbol ?? p.name, 14)),
      truncate(p.name, 26),
      usdPrice(p.priceUsd),
      pct(s, p.priceChangePct?.h1),
      pct(s, p.priceChangePct?.h6),
      pct(s, p.priceChangePct?.h24),
      usdCompact(p.volumeUsd?.h24),
      usdCompact(p.liquidityUsd),
      tx ? `${tx.buys ?? 0}/${tx.sells ?? 0}` : "—",
      age(p.createdAt),
    ];
  });
  const headers = ["#", "TOKEN", "PAIR", "PRICE", "1H", "6H", "24H", "VOL 24H", "LIQUIDITY", "BUY/SELL", "AGE"];
  const align: Array<"left" | "right"> = ["right", "left", "left", "right", "right", "right", "right", "right", "right", "right", "right"];
  // Pace rankings (volume-drop / volume-up): show the computed ratio next to the provider fields.
  if (pools[0]?.metric && /^pace/.test(pools[0].metric.name)) {
    headers.push("PACE");
    align.push("right");
    pools.slice(0, limit).forEach((p, i) => rows[i]!.push(p.metric ? `${p.metric.value.toFixed(2)}×` : "—"));
  }
  for (const line of table(s, headers, rows, align)) ctx.out(line);
  if (pools.length > limit) ctx.out(s.dim(`  … ${pools.length - limit} more (use --limit or --json)`));
  if (d.formula) ctx.out(s.dim(`  ranking: ${d.formula}`));
  return 0;
}

function limitOf(flags: LiveFlags): number {
  const limit = int(flags.limit, "limit") ?? 20;
  if (limit < 1 || limit > 200) throw new UsageError("--limit must be 1–200");
  return limit;
}

function moverFlags(flags: LiveFlags): { window?: "h1" | "h6" | "h24"; minLiquidity?: number; limit?: number } {
  const out: { window?: "h1" | "h6" | "h24"; minLiquidity?: number; limit?: number } = {};
  if (flags.window) {
    const w = ({ h1: "h1", "1h": "h1", h6: "h6", "6h": "h6", h24: "h24", "24h": "h24" } as Record<string, "h1" | "h6" | "h24">)[flags.window];
    if (!w) throw new UsageError("--window must be 1h, 6h or 24h");
    out.window = w;
  }
  if (flags.minLiquidity !== undefined) {
    const n = Number(flags.minLiquidity);
    if (!Number.isFinite(n) || n < 0) throw new UsageError("--min-liquidity must be a number ≥ 0");
    out.minLiquidity = n;
  }
  out.limit = Math.min(limitOf(flags), 50);
  return out;
}

export async function marketCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub, network] = positionals;
  const market = dataFor(ctx).market;
  const usage = "splice market trending|new|top|gainers|losers|volume|volume-drop|volume-up|liquidity|txns [network] | token|pairs|price|quotes <network> <address> | pair|ohlcv|trades <network> <pool> | search <query> | networks";
  const f = fresh(flags);
  const req = (i: number, what: string) => need(positionals, i, `splice market ${sub} <network> <${what}>`);
  switch (sub) {
    case "token":
      return emit(ctx, "market token", await market.token(req(1, "address"), req(2, "address"), f));
    case "pairs":
      return emit(ctx, "market pairs", await market.pairs(req(1, "address"), req(2, "address"), f));
    case "pair":
      return emit(ctx, "market pair", await market.pair(req(1, "pool"), req(2, "pool"), f));
    case "price":
      return emit(ctx, "market price", await market.tokenPrice(req(1, "address"), req(2, "address"), { ...f, ...(flags.vs ? { vs: flags.vs } : {}) }));
    case "quotes":
      return emit(ctx, "market quotes", await market.quotes(req(1, "address"), req(2, "address"), f));
    case "ohlcv": {
      const options: { timeframe?: string; aggregate?: number; limit?: number; fresh?: boolean } = { ...f };
      if (flags.timeframe) options.timeframe = flags.timeframe;
      const aggregate = int(flags.aggregate, "aggregate");
      const limit = int(flags.limit, "limit");
      if (aggregate !== undefined) options.aggregate = aggregate;
      if (limit !== undefined) options.limit = limit;
      return emit(ctx, "market ohlcv", await market.ohlcv(req(1, "pool"), req(2, "pool"), options));
    }
    case "trades":
      return emit(ctx, "market trades", await market.trades(req(1, "pool"), req(2, "pool"), f));
    case "search":
      return emit(ctx, "market search", await market.search(positionals.slice(1).join(" ") || need(positionals, 1, 'splice market search "<query>"'), f));
    case "networks": {
      const result = await market.networks(f);
      if (ctx.json || !isLive(result)) return emit(ctx, "market networks", result);
      const d = result.data as { count: number; networks: Array<{ id: string; name?: string }> };
      ctx.out(`${ctx.style.bold("market networks")}  ${statusLine(ctx, result)}  count=${d.count}`);
      ctx.out(d.networks.map((n) => n.id).join("  "));
      return 0;
    }
    case "trending": {
      const duration = flags.window ? ({ h1: "1h", h6: "6h", h24: "24h", "5m": "5m", "1h": "1h", "6h": "6h", "24h": "24h" } as Record<string, string>)[flags.window] : undefined;
      if (flags.window && !duration) throw new UsageError("--window must be 5m, 1h, 6h or 24h");
      return emitPools(ctx, "market trending", await market.trendingPools(network ?? "robinhood", { ...f, ...(duration ? { duration } : {}) }), limitOf(flags));
    }
    case "new":
      return emitPools(ctx, "market new", await market.newPools(network ?? "robinhood", f), limitOf(flags));
    case "top": {
      const sort = flags.sort ?? "volume";
      if (sort !== "volume" && sort !== "txns") throw new UsageError("--sort must be volume or txns");
      const page = int(flags.page, "page");
      return emitPools(ctx, "market top", await market.topPools(network ?? "robinhood", { ...f, sort, ...(page !== undefined ? { page } : {}) }), limitOf(flags));
    }
    case "gainers":
    case "losers":
    case "volume":
    case "volume-drop":
    case "volume-up":
    case "liquidity":
    case "txns":
      return emitPools(ctx, `market ${sub}`, await market.movers(network ?? "robinhood", { ...f, ...moverFlags(flags), kind: sub }), limitOf(flags));
    case "dexes":
      return emit(ctx, "market dexes", await market.dexes(network ?? need(positionals, 1, "splice market dexes <network>"), f));
    default:
      throw new UsageError(`unknown subcommand "market ${sub ?? ""}"`, `Usage: ${usage}`);
  }
}

// ------------------------------------------------------------------------------------------- defi

export async function defiCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const sub = positionals[0] ?? "overview";
  const defi = dataFor(ctx).defi;
  const s = ctx.style;
  const f = fresh(flags);
  const limit = int(flags.limit, "limit");
  const usage = "splice defi [overview] | protocols [--search q] | dexes | fees | yields [--sort tvl|apy] [--min-liquidity usd] | stablecoins | price <token> [--timeframe 1h|4h|1d] [--limit n]";
  const header = (label: string, r: DataResult<unknown>) => ctx.out(`${s.bold(label)}  ${statusLine(ctx, r)}`);
  switch (sub) {
    case "overview": {
      const result = await defi.overview(f);
      if (ctx.json || !("sections" in result)) return emit(ctx, "defi overview", result);
      const sec = result.sections as Record<string, DataResult<any>>;
      ctx.out(s.bold("defi  Robinhood Chain (DefiLlama)"));
      const row = (label: string, r: DataResult<any> | undefined, text: (d: any) => string) => r && ctx.out(`  ${label.padEnd(12)} ${isLive(r) ? text(r.data) : s.dim(statusLine(ctx, r))}`);
      row("TVL", sec.tvl, (d) => `${usdCompact(d.tvlUsd)}  1d ${pct(s, d.change1dPct)}  7d ${pct(s, d.change7dPct)}  30d ${pct(s, d.change30dPct)}  ${sparkline((d.history ?? []).map((h: any) => h.tvlUsd))}`);
      row("DEX volume", sec.dexVolume, (d) => `${usdCompact(d.total24hUsd)} 24h  1d ${pct(s, d.change1dPct)}  ${usdCompact(d.total7dUsd)} 7d  ${s.dim(`${d.count} DEXes`)}`);
      row("Fees", sec.fees, (d) => `${usdCompact(d.total24hUsd)} 24h  ${usdCompact(d.total7dUsd)} 7d  ${s.dim(`${d.count} protocols`)}`);
      row("Stablecoins", sec.stablecoins, (d) => `${usdCompact(d.circulatingUsd)} circulating  7d ${pct(s, d.change7dPct)}  ${s.dim(`minted ${usdCompact(d.mintedUsd)} · bridged ${usdCompact(d.bridgedUsd)}`)}`);
      ctx.out(s.dim("  More: splice defi protocols | dexes | fees | yields | stablecoins"));
      return 0;
    }
    case "protocols": {
      const result = await defi.protocols({ ...f, ...(flags.search ? { search: flags.search } : {}), limit: limit ?? 25 });
      if (ctx.json || !isLive(result)) return emit(ctx, "defi protocols", result);
      const d = result.data as unknown as { protocols: Array<{ name: string; category?: string; tvlOnChainUsd: number; totalTvlUsd?: number; change1dPct?: number; change7dPct?: number }> };
      header("defi protocols", result);
      const rows = d.protocols.map((p, i) => [String(i + 1), s.bold(truncate(p.name, 28)), truncate(p.category, 18), usdCompact(p.tvlOnChainUsd), usdCompact(p.totalTvlUsd), pct(s, p.change1dPct), pct(s, p.change7dPct)]);
      for (const l of table(s, ["#", "PROTOCOL", "CATEGORY", "TVL (CHAIN)", "TVL (ALL)", "1D", "7D"], rows, ["right", "left", "left", "right", "right", "right", "right"])) ctx.out(l);
      for (const n of result.provenance.notes ?? []) ctx.out(s.dim(`  note: ${n}`));
      return 0;
    }
    case "dexes":
    case "fees": {
      const result = sub === "dexes" ? await defi.dexes(f) : await defi.fees(f);
      if (ctx.json || !isLive(result)) return emit(ctx, `defi ${sub}`, result);
      const d = result.data as { total24hUsd?: number; total7dUsd?: number; change1dPct?: number; protocols: Array<{ name: string; category?: string; total24hUsd: number; total7dUsd?: number; change1dPct?: number }> };
      header(`defi ${sub}`, result);
      ctx.out(`  total ${usdCompact(d.total24hUsd)} 24h · ${usdCompact(d.total7dUsd)} 7d · 1d ${pct(s, d.change1dPct)}`);
      const rows = d.protocols.slice(0, limit ?? 20).map((p, i) => [String(i + 1), s.bold(truncate(p.name, 28)), truncate(p.category, 16), usdCompact(p.total24hUsd), usdCompact(p.total7dUsd), pct(s, p.change1dPct)]);
      for (const l of table(s, ["#", "PROTOCOL", "CATEGORY", sub === "dexes" ? "VOL 24H" : "FEES 24H", sub === "dexes" ? "VOL 7D" : "FEES 7D", "1D"], rows, ["right", "left", "left", "right", "right", "right"])) ctx.out(l);
      return 0;
    }
    case "yields": {
      const sort = flags.sort ?? "tvl";
      if (sort !== "tvl" && sort !== "apy") throw new UsageError("--sort must be tvl or apy");
      const minTvl = flags.minLiquidity !== undefined ? Number(flags.minLiquidity) : undefined;
      if (minTvl !== undefined && !Number.isFinite(minTvl)) throw new UsageError("--min-liquidity must be a number");
      const result = await defi.yields({ ...f, sort, ...(minTvl !== undefined ? { minTvl } : {}), ...(flags.search ? { search: flags.search } : {}), limit: limit ?? 20 });
      if (ctx.json || !isLive(result)) return emit(ctx, "defi yields", result);
      const d = result.data as { pools: Array<{ project: string; symbol: string; tvlUsd?: number; apyPct?: number; apyBasePct?: number; apyRewardPct?: number; stablecoin?: boolean }> };
      header("defi yields", result);
      const rows = d.pools.map((p, i) => [String(i + 1), s.bold(truncate(p.project, 22)), truncate(p.symbol, 22), usdCompact(p.tvlUsd), p.apyPct !== undefined ? `${p.apyPct.toFixed(2)}%` : "—", p.apyBasePct !== undefined ? `${p.apyBasePct.toFixed(2)}%` : "—", p.apyRewardPct !== undefined ? `${p.apyRewardPct.toFixed(2)}%` : "—", p.stablecoin ? "yes" : ""]);
      for (const l of table(s, ["#", "PROJECT", "POOL", "TVL", "APY", "BASE", "REWARD", "STABLE"], rows, ["right", "left", "left", "right", "right", "right", "right", "left"])) ctx.out(l);
      ctx.out(s.dim("  APY as reported by DefiLlama; past yield is not a promise of future yield."));
      return 0;
    }
    case "stablecoins":
      return emit(ctx, "defi stablecoins", await defi.stablecoins(f));
    case "price": {
      const address = need(positionals, 1, "splice defi price <token-address> [--timeframe 1h|4h|1d] [--limit n]");
      const result = await defi.priceChart(address, { ...f, ...(flags.timeframe ? { period: flags.timeframe } : {}), ...(limit !== undefined ? { points: limit } : {}) });
      if (ctx.json || !isLive(result)) return emit(ctx, "defi price", result);
      const d = result.data as { symbol?: string; period: string; points: Array<{ time: string; priceUsd: string }> };
      const values = d.points.map((p) => Number(p.priceUsd));
      header(`defi price ${d.symbol ?? address}`, result);
      ctx.out(`  ${sparkline(values)}  ${usdPrice(values[values.length - 1])}  ${pct(s, ((values[values.length - 1]! - values[0]!) / values[0]!) * 100)} ${s.dim(`over ${d.points.length} × ${d.period}`)}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown subcommand "defi ${sub}"`, `Usage: ${usage}`);
  }
}

// ------------------------------------------------------------------------------------------ stock

const STOCK_MOVERS = ["gainers", "losers", "volume", "volume-drop", "volume-up", "liquidity", "txns"];

export async function stockCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub] = positionals;
  const stocks = dataFor(ctx).stocks;
  const s = ctx.style;
  const usage = "splice stock list [--search <q>] | splice stock quote <SYMBOL> | splice stock gainers|losers|volume|volume-drop|volume-up|liquidity|txns [--window 1h|6h|24h]";
  if (!sub) throw new UsageError("missing subcommand", `Usage: ${usage}`);
  if (sub === "list") {
    const q = flags.search ?? positionals.slice(1).join(" ").trim();
    const result = await stocks.tokens({ ...fresh(flags), ...(q ? { search: q } : {}) });
    if (ctx.json || !isLive(result)) return emit(ctx, "stock list", result);
    const d = result.data;
    ctx.out(`${s.bold("stock list")}  ${statusLine(ctx, result)}  count=${d.count}`);
    const limit = int(flags.limit, "limit") ?? 400;
    const rows = d.tokens.slice(0, limit).map((t) => [s.bold(t.symbol), truncate(t.name, 44), t.address]);
    for (const line of table(s, ["SYMBOL", "NAME", "CONTRACT (Robinhood Chain)"], rows)) ctx.out(line);
    return 0;
  }
  if (["news", "profile", "earnings", "market"].includes(sub)) return stockFinnhubCommand(ctx, sub, positionals, flags);
  if (STOCK_MOVERS.includes(sub)) {
    return emitPools(ctx, `stock ${sub}`, await stocks.movers({ ...fresh(flags), ...moverFlags(flags), kind: sub as "gainers" }), limitOf(flags));
  }
  const symbol = sub === "quote" ? need(positionals, 1, "splice stock quote <SYMBOL>") : sub;
  const session = flags.session;
  if (session !== undefined && !["regular", "extended", "overnight"].includes(session)) throw new UsageError("--session must be regular, extended or overnight");
  const result = await stocks.quote(symbol, { ...fresh(flags), ...(session ? { session: session as "regular" } : {}) });
  if (ctx.json || !("sections" in result)) return emit(ctx, "stock quote", result);
  const sec = result.sections as Record<string, DataResult<any>>;
  const token = isLive(sec.token!) ? sec.token.data : undefined;
  ctx.out(`${s.bold(`stock ${result.subject}`)}  ${token ? `${token.name ?? ""}  ${s.dim(token.address)}` : s.yellow("not in the stock token list")}`);
  const line = (label: string, r: DataResult<any> | undefined, text: (d: any) => string) => {
    if (!r) return;
    const why = r.status === "ERROR" && r.attempts?.[0] ? ` — ${truncate(r.attempts[0].error, 110)}` : "";
    ctx.out(`  ${label.padEnd(10)} ${isLive(r) ? `${text(r.data)}  ` : ""}${s.dim(statusLine(ctx, r).replace(/\s+fetched=\S+/, "").replace(/\s+resource=\S+/, "") + why)}`);
  };
  line("robinhood", sec.robinhood, (d) => `token ${usdPrice(d?.tokenBid)} / ${usdPrice(d?.tokenAsk)}  stock bid ${usdPrice(d?.bid)} / ask ${usdPrice(d?.ask)}  day ${usdPrice(d?.dailyLow)}–${usdPrice(d?.dailyHigh)}${d?.isTradingHalt ? s.red("  TRADING HALT") : ""}`);
  line("chainlink", sec.chainlink, (d) => `${usdPrice(d?.price)}${d?.marketStatus ? `  market ${d.marketStatus}` : ""}${d?.source === "candlestick" ? s.dim(`  (1m candle ${String(d.observedAt ?? "").slice(11, 16)} UTC)`) : ""}`);
  line("dex", sec.dex, (d) => {
    // GeckoTerminal answers token totals; DexScreener answers per pair (the deepest pair is shown).
    if (Array.isArray(d?.pairs)) {
      const top = [...d.pairs].sort((a: any, b: any) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0))[0];
      return `${usdPrice(top?.priceUsd)}  24h ${pct(s, top?.priceChangePct?.h24)}  vol24h ${usdCompact(top?.volumeUsd?.h24)}  liquidity ${usdCompact(top?.liquidityUsd)}  ${s.dim(`deepest of ${d.pairs.length} pairs: ${top?.baseToken?.symbol ?? "?"}/${top?.quoteToken?.symbol ?? "?"}`)}`;
    }
    return `${usdPrice(d?.priceUsd)}  vol24h ${usdCompact(d?.volumeUsd?.h24)}  liquidity ${usdCompact(d?.totalReserveUsd)}  fdv ${usdCompact(d?.fdvUsd)}`;
  });
  line("finnhub", sec.finnhub, (d) => `${usdPrice(d?.priceUsd)}  ${pct(s, d?.changePct)}  ${s.dim(`underlying stock, day ${usdPrice(d?.low)}–${usdPrice(d?.high)}`)}`);
  line("codex", sec.codex, (d) => usdPrice(d?.prices?.[0]?.priceUsd));
  line("defillama", sec.defillama, (d) => `${usdPrice(d?.prices?.[0]?.priceUsd)}${d?.prices?.[0]?.confidence !== undefined ? s.dim(`  confidence ${d.prices[0].confidence}`) : ""}`);
  ctx.out(s.dim("  Sources are shown separately and never averaged. DEX prices can differ from the underlying stock; market data is not financial advice."));
  return 0;
}

// ----------------------------------------------------------------------------------------- oracle

export async function oracleCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub, ...args] = positionals;
  const oracle = dataFor(ctx).oracle;
  const usage = "splice oracle price <SYMBOL> [--session s] | splice oracle candles <SYMBOL> [--timeframe 1h] [--limit n] | splice oracle symbols [crypto|equities|forex] | splice oracle feeds [query]";
  const s = ctx.style;
  if (sub === "feeds") {
    const options: { search?: string; fresh?: boolean } = { ...fresh(flags) };
    const q = flags.search ?? args.join(" ").trim();
    if (q) options.search = q;
    const result = await oracle.feeds(options);
    if (ctx.json || !isLive(result)) return emit(ctx, "oracle feeds", result);
    const d = result.data as { count: number; feeds: Array<{ feedId: string; baseAsset?: string; quoteAsset?: string; assetClass?: string; attributeType?: string; marketHours?: string; schemaVersion?: string; status?: string; subscribed?: boolean }> };
    ctx.out(`${s.bold("oracle feeds")}  ${statusLine(ctx, result)}  count=${d.count}`);
    const limit = int(flags.limit, "limit") ?? 40;
    const rows = d.feeds.slice(0, limit).map((f) => [
      s.bold(`${f.baseAsset ?? "?"}/${f.quoteAsset ?? "?"}`),
      f.assetClass ?? "—",
      truncate(f.attributeType || f.marketHours, 30),
      f.schemaVersion ?? "—",
      f.status || "—",
      f.subscribed === undefined ? "—" : f.subscribed ? s.green("yes") : s.dim("no"),
      f.feedId,
    ]);
    for (const line of table(s, ["FEED", "CLASS", "TYPE", "SCHEMA", "STATUS", "SUBSCRIBED", "FEED ID"], rows)) ctx.out(line);
    if (d.feeds.length > limit) ctx.out(s.dim(`  … ${d.feeds.length - limit} more (use --limit, --search or --json)`));
    return 0;
  }
  if (sub === "candles") {
    const symbol = need(positionals, 1, "splice oracle candles <SYMBOL> [--timeframe 1m|5m|15m|30m|1h|4h|24h] [--limit n]");
    const limit = int(flags.limit, "limit");
    const result = await oracle.candles(symbol, { ...fresh(flags), ...(flags.timeframe ? { timeframe: flags.timeframe } : {}), ...(limit !== undefined ? { limit } : {}) });
    if (ctx.json || !isLive(result)) return emit(ctx, "oracle candles", result);
    const d = result.data;
    const closes = d.candles.map((c) => Number(c.close)).filter(Number.isFinite);
    const first = closes[0];
    const last = closes[closes.length - 1];
    ctx.out(`${s.bold(`oracle candles ${d.symbol}`)}  ${statusLine(ctx, result)}`);
    ctx.out(`  ${sparkline(closes)}  ${usdPrice(last)}  ${first ? pct(s, ((last! - first) / first) * 100) : ""} ${s.dim(`over ${d.candles.length} × ${d.resolution}`)}`);
    const rows = d.candles.slice(-Math.min(d.candles.length, 24)).map((c) => [c.time.replace("T", " ").slice(0, 16), usdPrice(c.open), usdPrice(c.high), usdPrice(c.low), usdPrice(c.close)]);
    for (const line of table(s, ["TIME (UTC)", "OPEN", "HIGH", "LOW", "CLOSE"], rows, ["left", "right", "right", "right", "right"])) ctx.out(line);
    return 0;
  }
  if (sub === "symbols") {
    const group = positionals[1];
    const result = await oracle.symbols({ ...fresh(flags), ...(group ? { group } : {}) });
    if (ctx.json || !isLive(result)) return emit(ctx, "oracle symbols", result);
    ctx.out(`${s.bold("oracle symbols")}  ${statusLine(ctx, result)}`);
    for (const g of (result.data as { groups: Array<{ group: string; symbols: string[] }> }).groups) ctx.out(`  ${s.bold(g.group)} (${g.symbols.length}): ${g.symbols.join(" ")}`);
    return 0;
  }
  if (sub === "price") {
    const symbol = need(positionals, 1, "splice oracle price <SYMBOL|feedId> [--session regular|extended|overnight]");
    const session = flags.session;
    if (session !== undefined && !["regular", "extended", "overnight"].includes(session)) throw new UsageError("--session must be regular, extended or overnight");
    const result = await oracle.price(symbol, { ...fresh(flags), ...(session ? { session: session as "regular" | "extended" | "overnight" } : {}) });
    if (ctx.json || !isLive(result)) return emit(ctx, "oracle price", result);
    const d = result.data as { feed?: { baseAsset?: string; attributeType?: string }; symbol?: string; source?: string; price?: string; bid?: string; ask?: string; marketStatus?: string; observedAt?: string; schemaVersion?: number };
    ctx.out(`${s.bold("oracle price")}  ${statusLine(ctx, result)}`);
    if (d.source === "candlestick") {
      ctx.out(`  ${s.bold(symbol.toUpperCase())}  ${usdPrice(d.price)}  ${s.dim(`latest 1-minute candle close · ${d.observedAt}`)}`);
      for (const n of result.provenance.notes ?? []) ctx.out(s.dim(`  note: ${n}`));
      return 0;
    }
    ctx.out(`  ${s.bold(d.feed?.baseAsset ?? symbol.toUpperCase())}  ${usdPrice(d.price)}${d.bid && d.ask ? s.dim(`  bid ${usdPrice(d.bid)} / ask ${usdPrice(d.ask)}`) : ""}${d.marketStatus ? `  market ${d.marketStatus}` : ""}`);
    ctx.out(s.dim(`  observed ${d.observedAt ?? "?"} · schema v${d.schemaVersion ?? "?"}${d.feed?.attributeType ? ` · ${d.feed.attributeType}` : ""}`));
    return 0;
  }
  throw new UsageError(`unknown subcommand "oracle ${sub ?? ""}"`, `Usage: ${usage}`);
}

// -------------------------------------------------------------------------------------------- web

export async function webCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const [sub, ...args] = positionals;
  const web = dataFor(ctx).web;
  const usage = 'splice web search|answer "<query>" | extract <url> [url...] | map <url> | similar <url>';
  const options: WebCallOptions = { ...fresh(flags) };
  if (flags.provider) options.provider = flags.provider;
  const limit = int(flags.limit, "limit");
  const maxChars = int(flags.maxChars, "max-chars");
  if (limit !== undefined) options.limit = limit;
  if (maxChars !== undefined) options.maxCharacters = maxChars;
  if (flags.content) options.content = true;
  if (flags.includeDomain?.length) options.includeDomains = flags.includeDomain;
  if (flags.excludeDomain?.length) options.excludeDomains = flags.excludeDomain;
  const text = args.join(" ").trim();
  switch (sub) {
    case "search":
      if (!text) throw new UsageError("missing query", `Usage: ${usage}`);
      return emit(ctx, "web search", await web.search(text, options));
    case "answer":
      if (!text) throw new UsageError("missing query", `Usage: ${usage}`);
      return emit(ctx, "web answer", await web.answer(text, options));
    case "extract":
      if (args.length === 0) throw new UsageError("missing URL", `Usage: ${usage}`);
      return emit(ctx, "web extract", await web.extract(args, options));
    case "map":
      return emit(ctx, "web map", await web.map(need(positionals, 1, "splice web map <url>"), options));
    case "similar":
      return emit(ctx, "web similar", await web.similar(need(positionals, 1, "splice web similar <url>"), options));
    default:
      throw new UsageError(`unknown subcommand "web ${sub ?? ""}"`, `Usage: ${usage}`);
  }
}