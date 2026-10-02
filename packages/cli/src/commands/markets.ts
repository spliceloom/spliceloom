/**
 * `splice tokens` (every Robinhood Chain token, from Codex), `splice global` (global crypto market,
 * sentiment, US equities) and `splice dash` (one screen of everything). Tables for humans, full
 * results with --json. Every row comes from a provider result; missing values print as "—".
 */
import { isLive, TOKEN_RANKS, type DataResult, type TokenRankKind } from "@spliceloom/data";
import { UsageError, type Context } from "../io.js";
import { age, pct, sparkline, table, truncate, usdCompact, usdPrice } from "../format.js";
import { dataFor, emit, need, statusLine } from "./data.js";
import type { LiveFlags } from "./providers-live.js";
import { whalesCommand } from "./pro.js";

const fresh = (flags: LiveFlags) => (flags.fresh ? { fresh: true } : {});

function intFlag(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer ${min}–${max}`);
  return n;
}

function windowFlag(value: string | undefined): "h1" | "h4" | "h12" | "h24" | undefined {
  if (value === undefined) return undefined;
  const w = ({ "1h": "h1", h1: "h1", "4h": "h4", h4: "h4", "12h": "h12", h12: "h12", "24h": "h24", h24: "h24" } as Record<string, "h1" | "h4" | "h12" | "h24">)[value];
  if (!w) throw new UsageError("--window must be 1h, 4h, 12h or 24h");
  return w;
}

interface TokenRow {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd?: string;
  changePct: Record<string, number>;
  volumeUsd: Record<string, string>;
  liquidityUsd?: string;
  marketCapUsd?: string;
  holders?: number;
  buys24?: number;
  sells24?: number;
  createdAt?: string;
}

function tokenTable(ctx: Context, tokens: TokenRow[], limit: number): void {
  const s = ctx.style;
  const rows = tokens.slice(0, limit).map((t, i) => [
    String(i + 1),
    s.bold(truncate(t.symbol, 12)),
    truncate(t.name, 22),
    usdPrice(t.priceUsd),
    pct(s, t.changePct.h1),
    pct(s, t.changePct.h4),
    pct(s, t.changePct.h24),
    usdCompact(t.volumeUsd.h24),
    usdCompact(t.liquidityUsd),
    usdCompact(t.marketCapUsd),
    t.holders !== undefined ? t.holders.toLocaleString("en-US") : "—",
    t.buys24 !== undefined ? `${t.buys24}/${t.sells24 ?? 0}` : "—",
    age(t.createdAt),
  ]);
  for (const line of table(s, ["#", "TOKEN", "NAME", "PRICE", "1H", "4H", "24H", "VOL 24H", "LIQUIDITY", "MCAP", "HOLDERS", "BUY/SELL", "AGE"], rows, ["right", "left", "left", "right", "right", "right", "right", "right", "right", "right", "right", "right", "right"])) ctx.out(line);
}

// ----------------------------------------------------------------------------------------- tokens

export async function tokensCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const sub = positionals[0] ?? "trending";
  const tokens = dataFor(ctx).tokens;
  const s = ctx.style;
  const limit = intFlag(flags.limit, "limit", 1, 100) ?? 20;
  const usage = `splice tokens ${Object.keys(TOKEN_RANKS).join("|")} [--window 1h|4h|12h|24h] [--min-liquidity usd] [--limit n] | search <query> | info|trades|chart <SYMBOL|address>`;
  if (sub in TOKEN_RANKS) {
    const minLiquidity = flags.minLiquidity !== undefined ? Number(flags.minLiquidity) : undefined;
    if (minLiquidity !== undefined && (!Number.isFinite(minLiquidity) || minLiquidity < 0)) throw new UsageError("--min-liquidity must be a number ≥ 0");
    const w = windowFlag(flags.window);
    const result = await tokens.rank(sub as TokenRankKind, { ...fresh(flags), limit, ...(w ? { window: w } : {}), ...(minLiquidity !== undefined ? { minLiquidity } : {}) });
    if (ctx.json || !isLive(result)) return emit(ctx, `tokens ${sub}`, result);
    ctx.out(`${s.bold(`tokens ${sub}`)}  ${statusLine(ctx, result)}`);
    if (result.data.tokens.length === 0) ctx.out(s.dim("  (no tokens match)"));
    else tokenTable(ctx, result.data.tokens, limit);
    if (result.data.filters) ctx.out(s.dim(`  ranking: ${result.data.filters}`));
    return 0;
  }
  switch (sub) {
    case "whales":
      return whalesCommand(ctx, positionals, flags);
    case "search": {
      const q = positionals.slice(1).join(" ").trim() || need(positionals, 1, "splice tokens search <name|symbol|address>");
      const result = await tokens.search(q, { ...fresh(flags), limit });
      if (ctx.json || !isLive(result)) return emit(ctx, "tokens search", result);
      ctx.out(`${s.bold(`tokens search "${q}"`)}  ${statusLine(ctx, result)}`);
      tokenTable(ctx, result.data.tokens, limit);
      for (const t of result.data.tokens.slice(0, limit)) ctx.out(s.dim(`  ${t.symbol ?? "?"}  ${t.address}`));
      return 0;
    }
    case "info": {
      const q = need(positionals, 1, "splice tokens info <SYMBOL|address>");
      const result = await tokens.details(q, fresh(flags));
      if (ctx.json || !("sections" in result)) return emit(ctx, "tokens info", result);
      const sec = result.sections as Record<string, DataResult<any>>;
      const info = isLive(sec.info!) ? sec.info.data : {};
      const st = sec.stats && isLive(sec.stats) ? sec.stats.data : undefined;
      ctx.out(`${s.bold(`${info.symbol ?? q.toUpperCase()}`)}  ${info.name ?? ""}  ${s.dim(result.subject)}`);
      if (st) {
        ctx.out(`  price ${usdPrice(st.priceUsd)}  1h ${pct(s, st.changePct?.h1)}  4h ${pct(s, st.changePct?.h4)}  24h ${pct(s, st.changePct?.h24)}`);
        ctx.out(`  volume 24h ${usdCompact(st.volumeUsd?.h24)}  liquidity ${usdCompact(st.liquidityUsd)}  mcap ${usdCompact(st.marketCapUsd)}  holders ${st.holders?.toLocaleString("en-US") ?? "—"}  buys/sells 24h ${st.buys24 ?? "—"}/${st.sells24 ?? "—"}  unique buyers ${st.uniqueBuyers24 ?? "—"}  age ${age(st.createdAt)}`);
      }
      if (sec.chart && isLive(sec.chart)) {
        const closes = (sec.chart.data.candles as Array<{ close?: string }>).map((c) => Number(c.close)).filter(Number.isFinite);
        ctx.out(`  24h ${sparkline(closes)}`);
      }
      if (info.totalSupply) ctx.out(s.dim(`  supply ${Number(info.totalSupply).toLocaleString("en-US")}${info.links ? ` · ${Object.values(info.links).join(" · ")}` : ""}`));
      if (sec.pairs && isLive(sec.pairs)) {
        ctx.out(s.bold("  pairs"));
        for (const p of (sec.pairs.data.pairs as Array<any>).slice(0, 5)) ctx.out(`    ${(p.exchange ?? "?").padEnd(14)} vol24h ${usdCompact(p.volumeUsd24h).padStart(8)}  liquidity ${usdCompact(p.liquidityUsd).padStart(8)}  ${s.dim(p.pairAddress ?? "")}`);
      }
      if (sec.trades && isLive(sec.trades)) {
        ctx.out(s.bold("  recent trades"));
        for (const t of (sec.trades.data.trades as Array<any>).filter((x) => x.type === "Buy" || x.type === "Sell").slice(0, 8)) ctx.out(`    ${String(t.time ?? "").slice(11, 19)}  ${t.type === "Buy" ? s.green("BUY ") : s.red("SELL")}  ${usdCompact(t.valueUsd).padStart(8)} @ ${usdPrice(t.priceUsd)}  ${s.dim(t.maker ?? "")}`);
      }
      for (const [name, r] of Object.entries(sec)) if (!isLive(r)) ctx.out(s.dim(`  ${name}: ${statusLine(ctx, r)}`));
      ctx.out(s.dim("  source: codex · not financial advice"));
      return 0;
    }
    case "trades":
    case "chart": {
      const q = need(positionals, 1, `splice tokens ${sub} <SYMBOL|address>`);
      const resolved = await tokens.resolve(q, fresh(flags));
      if ("status" in resolved) return emit(ctx, `tokens ${sub}`, resolved as DataResult<unknown>);
      if (sub === "trades") {
        const result = await tokens.trades(resolved.address, { ...fresh(flags), limit: intFlag(flags.limit, "limit", 1, 100) ?? 25 });
        if (ctx.json || !isLive(result)) return emit(ctx, "tokens trades", result);
        ctx.out(`${s.bold(`tokens trades ${q.toUpperCase()}`)}  ${statusLine(ctx, result)}`);
        const rows = (result.data.trades as Array<any>).map((t) => [String(t.time ?? "").replace("T", " ").slice(0, 19), t.type === "Buy" ? s.green("BUY") : t.type === "Sell" ? s.red("SELL") : String(t.type ?? "?"), usdCompact(t.valueUsd), usdPrice(t.priceUsd), t.maker ?? "—"]);
        for (const line of table(s, ["TIME (UTC)", "TYPE", "VALUE", "PRICE", "WALLET"], rows, ["left", "left", "right", "right", "left"])) ctx.out(line);
        return 0;
      }
      const result = await tokens.chart(resolved.address, { ...fresh(flags), ...(flags.timeframe ? { timeframe: flags.timeframe } : {}), limit: intFlag(flags.limit, "limit", 2, 500) ?? 24 });
      if (ctx.json || !isLive(result)) return emit(ctx, "tokens chart", result);
      const candles = result.data.candles as Array<{ time: string; open?: string; high?: string; low?: string; close?: string; volumeUsd?: string }>;
      const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
      ctx.out(`${s.bold(`tokens chart ${q.toUpperCase()}`)}  ${statusLine(ctx, result)}`);
      ctx.out(`  ${sparkline(closes)}  ${usdPrice(closes[closes.length - 1])}  ${closes[0] ? pct(s, ((closes[closes.length - 1]! - closes[0]) / closes[0]) * 100) : ""}`);
      const rows = candles.slice(-24).map((c) => [c.time.replace("T", " ").slice(0, 16), usdPrice(c.open), usdPrice(c.high), usdPrice(c.low), usdPrice(c.close), usdCompact(c.volumeUsd)]);
      for (const line of table(s, ["TIME (UTC)", "OPEN", "HIGH", "LOW", "CLOSE", "VOLUME"], rows, ["left", "right", "right", "right", "right", "right"])) ctx.out(line);
      return 0;
    }
    default:
      throw new UsageError(`unknown subcommand "tokens ${sub}"`, `Usage: ${usage}`);
  }
}

// ----------------------------------------------------------------------------------------- global

export async function globalCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const sub = positionals[0] ?? "overview";
  const global = dataFor(ctx).global;
  const s = ctx.style;
  const limit = intFlag(flags.limit, "limit", 1, 250);
  switch (sub) {
    case "overview": {
      const result = await global.overview(fresh(flags));
      if (ctx.json || !("sections" in result)) return emit(ctx, "global", result);
      printGlobal(ctx, result.sections as Record<string, DataResult<any>>, limit ?? 10);
      return 0;
    }
    case "coins": {
      const result = await global.coins({ ...fresh(flags), limit: limit ?? 25 });
      if (ctx.json || !isLive(result)) return emit(ctx, "global coins", result);
      ctx.out(`${s.bold("global coins")}  ${statusLine(ctx, result)}`);
      coinTable(ctx, result.data.coins as Array<any>);
      return 0;
    }
    case "trending": {
      const result = await global.trending(fresh(flags));
      if (ctx.json || !isLive(result)) return emit(ctx, "global trending", result);
      ctx.out(`${s.bold("global trending")}  ${statusLine(ctx, result)}`);
      const rows = (result.data.coins as Array<any>).map((c, i) => [String(i + 1), s.bold(c.symbol), truncate(c.name, 24), c.marketCapRank ? `#${c.marketCapRank}` : "—", usdPrice(c.priceUsd), pct(s, c.change24hPct), String(c.volume24h ?? "—")]);
      for (const line of table(s, ["#", "COIN", "NAME", "RANK", "PRICE", "24H", "VOL 24H"], rows, ["right", "left", "left", "right", "right", "right", "right"])) ctx.out(line);
      return 0;
    }
    case "sentiment":
      return emit(ctx, "global sentiment", await global.sentiment({ ...fresh(flags), days: limit ?? 7 }));
    case "stocks":
    case "equities": {
      const symbols = positionals.slice(1).map((x) => x.toUpperCase());
      const result = await global.equities(symbols.length ? symbols : undefined, fresh(flags));
      if (ctx.json || !isLive(result)) return emit(ctx, "global stocks", result);
      ctx.out(`${s.bold("global stocks (US equities / ETFs)")}  ${statusLine(ctx, result)}`);
      equityTable(ctx, result.data.quotes);
      for (const n of result.provenance.notes ?? []) ctx.out(s.dim(`  note: ${n}`));
      return 0;
    }
    default:
      throw new UsageError(`unknown subcommand "global ${sub}"`, "Usage: splice global [overview] | coins [--limit n] | trending | sentiment | stocks [SYMBOL...]");
  }
}

function coinTable(ctx: Context, coins: Array<any>): void {
  const s = ctx.style;
  const rows = coins.map((c) => [String(c.rank ?? "—"), s.bold(c.symbol), truncate(c.name, 18), usdPrice(c.priceUsd), pct(s, c.change1hPct), pct(s, c.change24hPct), pct(s, c.change7dPct), usdCompact(c.marketCapUsd), usdCompact(c.volume24hUsd)]);
  for (const line of table(s, ["#", "COIN", "NAME", "PRICE", "1H", "24H", "7D", "MCAP", "VOL 24H"], rows, ["right", "left", "left", "right", "right", "right", "right", "right", "right"])) ctx.out(line);
}

function equityTable(ctx: Context, quotes: Array<{ symbol: string; priceUsd?: string; change24hPct?: number; status: string }>): void {
  const s = ctx.style;
  const rows = quotes.map((q) => [s.bold(q.symbol), usdPrice(q.priceUsd), pct(s, q.change24hPct), q.status === "LIVE" ? "" : s.dim(q.status)]);
  for (const line of table(s, ["SYMBOL", "PRICE", "24H", ""], rows, ["left", "right", "right", "left"])) ctx.out(line);
}

function printGlobal(ctx: Context, sec: Record<string, DataResult<any>>, coins: number): void {
  const s = ctx.style;
  const c = sec.crypto && isLive(sec.crypto) ? sec.crypto.data : undefined;
  if (c) {
    const dom = Object.entries(c.dominancePct ?? {}).slice(0, 3).map(([k, v]) => `${k} ${v}%`).join(" · ");
    ctx.out(`${s.bold("crypto")}  market cap ${usdCompact(c.totalMarketCapUsd)} ${pct(s, c.marketCapChange24hPct)}  volume 24h ${usdCompact(c.totalVolumeUsd)}  dominance ${dom}  ${s.dim("(coingecko)")}`);
  } else if (sec.crypto) ctx.out(`${s.bold("crypto")}  ${statusLine(ctx, sec.crypto)}`);
  const f = sec.sentiment && isLive(sec.sentiment) ? sec.sentiment.data : undefined;
  if (f?.latest) {
    const values = [...(f.history ?? [])].reverse().map((h: any) => h.value);
    const label = f.latest.value >= 55 ? s.green(f.latest.classification) : f.latest.value <= 45 ? s.red(f.latest.classification) : f.latest.classification;
    ctx.out(`${s.bold("sentiment")}  Fear & Greed ${f.latest.value} ${label}  7d ${sparkline(values)}  ${s.dim("(alternative.me)")}`);
  }
  if (sec.majors && isLive(sec.majors)) {
    ctx.out(s.bold("top coins"));
    coinTable(ctx, (sec.majors.data.coins as Array<any>).slice(0, coins));
  }
  if (sec.equities && isLive(sec.equities)) {
    ctx.out(`${s.bold("US stocks / ETFs")}  ${s.dim("(chainlink candlestick)")}`);
    const quotes = sec.equities.data.quotes as Array<{ symbol: string; priceUsd?: string; change24hPct?: number; status: string }>;
    ctx.out(`  ${quotes.map((q) => `${s.bold(q.symbol)} ${usdPrice(q.priceUsd)} ${pct(s, q.change24hPct)}`).join("   ")}`);
  }
}

// ------------------------------------------------------------------------------------------ perps

export async function perpsCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const sub = positionals[0] ?? "markets";
  const perps = dataFor(ctx).perps;
  const s = ctx.style;
  const venue = flags.venue ?? "robinhood";
  const limit = intFlag(flags.limit, "limit", 1, 300) ?? 25;
  const f = fresh(flags);
  const marketRows = (markets: Array<any>) =>
    markets.map((m, i) => [String(i + 1), s.bold(m.symbol), m.type, usdPrice(m.markPrice ?? m.lastPrice), pct(s, m.change24hPct), usdCompact(m.volume24hUsd), usdCompact(m.openInterestUsd), m.trades24h !== undefined ? m.trades24h.toLocaleString("en-US") : "—", m.initialMarginPct !== undefined ? `${m.initialMarginPct}%` : "—"]);
  const headers = ["#", "MARKET", "TYPE", "PRICE", "24H", "VOL 24H", "OPEN INT", "TRADES", "INIT MARGIN"];
  const align: Array<"left" | "right"> = ["right", "left", "left", "right", "right", "right", "right", "right", "right"];
  switch (sub) {
    case "markets":
    case "top":
    case "gainers":
    case "losers":
    case "oi":
    case "spot": {
      const sort = sub === "gainers" ? "change" : sub === "losers" ? "losers" : sub === "oi" ? "oi" : ((flags.sort as "volume" | "oi" | "change") ?? "volume");
      const result = await perps.markets({ ...f, venue, sort, type: sub === "spot" ? "spot" : "perp", limit, ...(flags.search ? { search: flags.search } : {}) });
      if (ctx.json || !isLive(result)) return emit(ctx, `perps ${sub}`, result);
      const stats = await perps.stats({ ...f, venue });
      const st = isLive(stats) ? (stats.data as any) : undefined;
      ctx.out(`${s.bold(`perps ${sub}`)} ${s.dim(`· ${result.data.label}${st ? ` · ${st.markets} markets · ${usdCompact(st.volume24hUsd)} 24h volume` : ""}`)}  ${statusLine(ctx, result)}`);
      for (const l of table(s, headers, marketRows(result.data.markets), align)) ctx.out(l);
      ctx.out(s.dim("  open interest in USD = open interest × mark price; initial margin as Lighter's default fraction"));
      return 0;
    }
    case "funding": {
      const result = await perps.funding({ ...f, venue, limit, ...(flags.search ? { search: flags.search } : {}) });
      if (ctx.json || !isLive(result)) return emit(ctx, "perps funding", result);
      ctx.out(`${s.bold("perps funding")}  ${statusLine(ctx, result)}`);
      const fmt = (v: number | undefined) => (v === undefined ? "—" : v > 0 ? s.green(`${v.toFixed(4)}%`) : v < 0 ? s.red(`${v.toFixed(4)}%`) : `${v.toFixed(4)}%`);
      const rows = (result.data.rates as Array<{ symbol: string; percentPerInterval: Record<string, number> }>).map((r) => [s.bold(r.symbol), fmt(r.percentPerInterval.lighter), fmt(r.percentPerInterval.binance), fmt(r.percentPerInterval.bybit), fmt(r.percentPerInterval.hyperliquid)]);
      for (const l of table(s, ["MARKET", "LIGHTER", "BINANCE", "BYBIT", "HYPERLIQUID"], rows, ["left", "right", "right", "right", "right"])) ctx.out(l);
      for (const n of result.provenance.notes ?? []) ctx.out(s.dim(`  note: ${n}`));
      return 0;
    }
    case "stats":
      return emit(ctx, "perps stats", await perps.stats({ ...f, venue }));
    default: {
      // splice perps <SYMBOL>
      const result = await perps.markets({ ...f, venue, type: "all", search: sub, limit: 10 });
      if (ctx.json || !isLive(result)) return emit(ctx, `perps ${sub}`, result);
      const exact = result.data.markets.filter((m) => m.symbol.toUpperCase() === sub.toUpperCase() || m.symbol.toUpperCase().startsWith(`${sub.toUpperCase()}-`));
      const shown = exact.length ? exact : result.data.markets;
      if (shown.length === 0) throw new UsageError(`no Lighter market matches "${sub}"`, "Try: splice perps markets --search <text>");
      ctx.out(`${s.bold(`perps ${sub.toUpperCase()}`)} ${s.dim(`· ${result.data.label}`)}  ${statusLine(ctx, result)}`);
      for (const l of table(s, headers, marketRows(shown), align)) ctx.out(l);
      const funding = await perps.funding({ ...f, venue, search: sub, limit: 5 });
      if (isLive(funding)) for (const r of funding.data.rates as Array<{ symbol: string; percentPerInterval: Record<string, number> }>) ctx.out(s.dim(`  funding ${r.symbol}: ${Object.entries(r.percentPerInterval).map(([k, v]) => `${k} ${v.toFixed(4)}%`).join(" · ")}`));
      return 0;
    }
  }
}

// ------------------------------------------------------------------------------------------ macro

export async function macroCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const macro = dataFor(ctx).macro;
  const s = ctx.style;
  const id = positionals[0];
  if (!id || id === "overview") {
    const result = await macro.overview(fresh(flags));
    if (ctx.json || !isLive(result)) return emit(ctx, "macro", result);
    ctx.out(`${s.bold("macro  US economy (FRED)")}  ${statusLine(ctx, result)}`);
    const rows = result.data.series.map((m) => [s.bold(m.label), m.value !== undefined ? `${m.value}${m.unit === "%" || m.unit === "pp" ? m.unit === "%" ? "%" : " pp" : ""}` : s.dim(m.status), m.previous !== undefined ? s.dim(`prev ${m.previous}`) : "", m.date ?? "", m.id]);
    for (const l of table(s, ["SERIES", "LATEST", "PREVIOUS", "DATE", "FRED ID"], rows, ["left", "right", "left", "left", "left"])) ctx.out(l);
    ctx.out(s.dim("  More: splice macro <FRED_ID> [--limit n]   e.g. splice macro DGS10 --limit 60"));
    return 0;
  }
  const result = await macro.series(id, { ...fresh(flags), limit: intFlag(flags.limit, "limit", 1, 500) ?? 24 });
  if (ctx.json || !isLive(result)) return emit(ctx, `macro ${id}`, result);
  const d = result.data as { id: string; title?: string; units?: string; frequency?: string; points: Array<{ date: string; value: number }> };
  const values = d.points.map((p) => p.value);
  ctx.out(`${s.bold(`macro ${d.id}`)}  ${d.title ?? ""}  ${statusLine(ctx, result)}`);
  ctx.out(`  ${sparkline(values)}  latest ${values[values.length - 1]} ${d.units ?? ""} (${d.points[d.points.length - 1]!.date})  ${s.dim(`${d.points.length} × ${d.frequency ?? "?"}`)}`);
  return 0;
}

// ------------------------------------------------------------------------------------------- news

export async function newsCommand(ctx: Context, positionals: string[], flags: LiveFlags): Promise<number> {
  const data = dataFor(ctx);
  const s = ctx.style;
  const topic = (positionals[0] ?? "general").toLowerCase();
  const limit = intFlag(flags.limit, "limit", 1, 30) ?? 10;
  const result: DataResult<unknown> = ["general", "crypto", "forex", "merger"].includes(topic) ? await data.news.market(topic as "general", fresh(flags)) : await data.equities.news(topic, fresh(flags));
  if (ctx.json || !isLive(result)) return emit(ctx, `news ${topic}`, result);
  ctx.out(`${s.bold(`news ${topic}`)}  ${statusLine(ctx, result)}`);
  for (const n of ((result.data as any).news as Array<any>).slice(0, limit)) {
    ctx.out(`  ${s.dim(String(n.time ?? "").replace("T", " ").slice(0, 16))}  ${s.bold(n.headline ?? "")}  ${s.dim(`— ${n.source ?? "?"}`)}`);
    if (n.url) ctx.out(`    ${s.dim(n.url)}`);
  }
  ctx.out(s.dim("  Headlines are third-party content (Finnhub aggregation)."));
  return 0;
}

/** `splice stock news|profile|earnings|market` (Finnhub, US-listed underlying stocks). */
export async function stockFinnhubCommand(ctx: Context, sub: string, positionals: string[], flags: LiveFlags): Promise<number> {
  const eq = dataFor(ctx).equities;
  const s = ctx.style;
  const f = fresh(flags);
  if (sub === "news") return newsCommand(ctx, [need(positionals, 1, "splice stock news <TICKER>")], flags);
  if (sub === "market") {
    const r = await eq.marketStatus(f);
    if (ctx.json || !isLive(r)) return emit(ctx, "stock market", r);
    const d = r.data as any;
    ctx.out(`${s.bold("US stock market")}  ${d.isOpen ? s.green(`OPEN (${d.session})`) : s.red(`CLOSED${d.session ? ` (${d.session})` : ""}`)}${d.holiday ? `  holiday: ${d.holiday}` : ""}  ${s.dim(statusLine(ctx, r))}`);
    return 0;
  }
  if (sub === "earnings") {
    const r = await eq.earnings({ ...f, days: intFlag(flags.limit, "limit", 1, 30) ?? 7, ...(positionals[1] ? { symbol: positionals[1] } : {}) });
    if (ctx.json || !isLive(r)) return emit(ctx, "stock earnings", r);
    const d = r.data as any;
    ctx.out(`${s.bold(`earnings ${d.from} → ${d.to}`)}  ${statusLine(ctx, r)}  count=${d.count}`);
    // Largest expected revenue first, so the big reporters lead.
    const rows = [...(d.earnings as Array<any>)].sort((a, b) => (b.revenueEstimate ?? -1) - (a.revenueEstimate ?? -1)).slice(0, 40).map((e) => [e.date ?? "", s.bold(e.symbol), e.hour === "bmo" ? "before open" : e.hour === "amc" ? "after close" : (e.hour ?? ""), e.epsEstimate !== undefined ? String(Number(e.epsEstimate.toFixed(3))) : "—", e.epsActual !== undefined ? String(e.epsActual) : "—", usdCompact(e.revenueEstimate)]);
    for (const l of table(s, ["DATE", "TICKER", "WHEN", "EPS EST", "EPS ACT", "REV EST"], rows, ["left", "left", "left", "right", "right", "right"])) ctx.out(l);
    return 0;
  }
  // profile
  const symbol = need(positionals, 1, "splice stock profile <TICKER>");
  const [profile, quote] = await Promise.all([eq.profile(symbol, f), eq.quote(symbol, f)]);
  if (ctx.json) {
    ctx.out(JSON.stringify({ profile, quote }, null, 2));
    return 0;
  }
  if (!isLive(profile)) return emit(ctx, "stock profile", profile);
  const p = profile.data as any;
  const q = isLive(quote) ? (quote.data as any) : undefined;
  ctx.out(`${s.bold(`${p.symbol}  ${p.name}`)}  ${s.dim(`${p.exchange ?? ""} · ${p.industry ?? ""} · IPO ${p.ipo ?? "?"}`)}`);
  if (q) ctx.out(`  price ${usdPrice(q.priceUsd)} ${pct(s, q.changePct)}  day ${usdPrice(q.low)}–${usdPrice(q.high)}  prev close ${usdPrice(q.previousClose)}`);
  const m = p.metrics ?? {};
  ctx.out(`  market cap ${usdCompact(p.marketCapUsd)}  P/E ${m.peTTM?.toFixed?.(1) ?? "—"}  EPS ${m.epsTTM?.toFixed?.(2) ?? "—"}  beta ${m.beta?.toFixed?.(2) ?? "—"}  52w ${usdPrice(m.low52w)}–${usdPrice(m.high52w)} (${pct(s, m.return52wPct)})`);
  if (p.analysts) ctx.out(`  analysts (${p.analysts.period}): strong buy ${p.analysts.strongBuy} · buy ${p.analysts.buy} · hold ${p.analysts.hold} · sell ${p.analysts.sell} · strong sell ${p.analysts.strongSell}`);
  ctx.out(s.dim(`  ${p.website ?? ""}  · source: finnhub · not financial advice`));
  return 0;
}

// ------------------------------------------------------------------------------------------- dash

/** One screen: Robinhood Chain (ETH, TVL, DEX volume), trending and moving tokens, stock tokens, global markets. */
export async function dashCommand(ctx: Context, _positionals: string[], flags: LiveFlags): Promise<number> {
  const data = dataFor(ctx);
  const s = ctx.style;
  const f = fresh(flags);
  const [eth, defi, trending, gainers, losers, newTokens, stocks, global, marketStatus, macro, perps] = await Promise.all([
    data.market.price("ETH", f),
    data.defi.overview(f),
    data.tokens.rank("trending", { ...f, limit: 8 }),
    data.tokens.rank("gainers", { ...f, limit: 5 }),
    data.tokens.rank("losers", { ...f, limit: 5 }),
    data.tokens.rank("new", { ...f, limit: 5, minLiquidity: 5_000 }),
    data.stocks.movers({ ...f, kind: "volume", limit: 6 }),
    data.global.overview(f),
    data.equities.marketStatus(f),
    data.macro.overview(f),
    data.perps.markets({ ...f, limit: 6 }),
  ]);
  if (ctx.json) {
    ctx.out(JSON.stringify({ eth, defi, trending, gainers, losers, newTokens, stocks, global, marketStatus, macro, perps }, null, 2));
    return 0;
  }
  const line = "─".repeat(78);
  ctx.out(s.bold(`SPLICE DASHBOARD · Robinhood Chain (4663) · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`));
  ctx.out(s.dim(line));
  const e = isLive(eth) ? (eth.data as any) : undefined;
  const sec = "sections" in defi ? (defi.sections as Record<string, DataResult<any>>) : {};
  const tvl = sec.tvl && isLive(sec.tvl) ? sec.tvl.data : undefined;
  const dex = sec.dexVolume && isLive(sec.dexVolume) ? sec.dexVolume.data : undefined;
  const fees = sec.fees && isLive(sec.fees) ? sec.fees.data : undefined;
  const stable = sec.stablecoins && isLive(sec.stablecoins) ? sec.stablecoins.data : undefined;
  ctx.out(`${s.bold("ETH")} ${usdPrice(e?.price)} ${pct(s, e?.change24hPct)}   ${s.bold("TVL")} ${usdCompact(tvl?.tvlUsd)} ${pct(s, tvl?.change1dPct)}   ${s.bold("DEX vol")} ${usdCompact(dex?.total24hUsd)}   ${s.bold("fees")} ${usdCompact(fees?.total24hUsd)}   ${s.bold("stables")} ${usdCompact(stable?.circulatingUsd)}`);
  const ms = isLive(marketStatus) ? (marketStatus.data as any) : undefined;
  const mac = isLive(macro) ? (macro.data.series as Array<{ id: string; value?: number }>) : [];
  const mv = (id: string) => mac.find((m) => m.id === id)?.value;
  ctx.out(`${s.bold("US market")} ${ms ? (ms.isOpen ? s.green(`open (${ms.session})`) : s.red("closed")) : "—"}   ${s.bold("Fed funds")} ${mv("DFF") ?? "—"}%   ${s.bold("CPI")} ${mv("CPIAUCSL") ?? "—"}% y/y   ${s.bold("10Y")} ${mv("DGS10") ?? "—"}%   ${s.bold("VIX")} ${mv("VIXCLS") ?? "—"}`);
  const mini = (title: string, r: DataResult<any>, metric: (t: TokenRow) => string) => {
    ctx.out(`\n${s.bold(title)}`);
    if (!isLive(r)) return ctx.out(`  ${statusLine(ctx, r)}`);
    const rows = (r.data.tokens as TokenRow[]).map((t) => [s.bold(truncate(t.symbol, 12)), usdPrice(t.priceUsd), metric(t), usdCompact(t.volumeUsd.h24), usdCompact(t.liquidityUsd), age(t.createdAt)]);
    for (const l of table(s, ["TOKEN", "PRICE", "MOVE", "VOL 24H", "LIQ", "AGE"], rows, ["left", "right", "right", "right", "right", "right"])) ctx.out(l);
  };
  mini("🔥 trending (codex)", trending, (t) => pct(s, t.changePct.h24));
  mini("▲ top gainers 24h", gainers, (t) => pct(s, t.changePct.h24));
  mini("▼ top losers 24h", losers, (t) => pct(s, t.changePct.h24));
  mini("✦ new tokens", newTokens, (t) => pct(s, t.changePct.h1));
  ctx.out(`\n${s.bold("📈 stock tokens by DEX volume")}`);
  if (isLive(stocks)) {
    const rows = stocks.data.pools.map((p) => [s.bold(p.baseToken?.symbol ?? "?"), usdPrice(p.priceUsd), pct(s, p.priceChangePct?.h24), usdCompact(p.volumeUsd?.h24), usdCompact(p.liquidityUsd)]);
    for (const l of table(s, ["STOCK", "PRICE", "24H", "VOL 24H", "LIQ"], rows, ["left", "right", "right", "right", "right"])) ctx.out(l);
  } else ctx.out(`  ${statusLine(ctx, stocks)}`);
  ctx.out(`\n${s.bold("⚡ perps on Robinhood (Lighter)")}`);
  if (isLive(perps)) {
    const rows = (perps.data.markets as Array<any>).map((m) => [s.bold(m.symbol), usdPrice(m.markPrice ?? m.lastPrice), pct(s, m.change24hPct), usdCompact(m.volume24hUsd), usdCompact(m.openInterestUsd)]);
    for (const l of table(s, ["MARKET", "MARK", "24H", "VOL 24H", "OPEN INT"], rows, ["left", "right", "right", "right", "right"])) ctx.out(l);
  } else ctx.out(`  ${statusLine(ctx, perps)}`);
  ctx.out(`\n${s.bold("🌍 global markets")}`);
  if ("sections" in global) printGlobal(ctx, global.sections as Record<string, DataResult<any>>, 5);
  ctx.out(s.dim(line));
  ctx.out(s.dim("sources: coingecko · defillama · codex · chainlink · lighter · finnhub · fred · alternative.me · not financial advice · details: splice tokens info <SYMBOL>"));
  return 0;
}
