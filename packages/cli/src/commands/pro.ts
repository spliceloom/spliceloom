/**
 * Research and monitoring commands:
 *   splice report <token>           research/risk report (Codex + GoPlus + Blockscout), flags with sources
 *   splice tokens whales <token>    large trades, buy/sell totals, net flow, wallets
 *   splice compare <a> <b> [...]    tokens side by side
 *   splice watchlist [add|remove]   personal list (tokens, stock tokens, perps) with live prices
 *   splice watch <token> [...]      live monitor with alerts (price above/below, % change, whale trades)
 *   splice radar                    new tokens as they appear, each with a quick security check
 * Watch loops stop with Ctrl+C (or after --count ticks). Every value comes from a provider result.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spliceHome } from "@spliceloom/core";
import { isLive, type CodexToken, type DataResult, type ResearchReport, type SpliceData } from "@spliceloom/data";
import { UsageError, type Context } from "../io.js";
import { age, pct, table, truncate, usdCompact, usdPrice } from "../format.js";
import { dataFor, emit, need, statusLine } from "./data.js";
import type { LiveFlags } from "./providers-live.js";

export interface ProFlags extends LiveFlags {
  above?: string;
  below?: string;
  change?: string;
  interval?: string;
  count?: string;
  min?: string;
}

const fresh = (flags: LiveFlags) => (flags.fresh ? { fresh: true } : {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function numFlag(v: string | undefined, name: string, min = -Infinity): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number${min > -Infinity ? ` ≥ ${min}` : ""}`);
  return n;
}

// ----------------------------------------------------------------------------------------- report

export async function reportCommand(ctx: Context, positionals: string[], flags: ProFlags): Promise<number> {
  const q = need(positionals, 0, "splice report <SYMBOL|address>");
  const result = await dataFor(ctx).research.report(q, fresh(flags));
  if (ctx.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return "kind" in result && result.kind === "report" ? 0 : 1;
  }
  if (!("kind" in result) || result.kind !== "report") return emit(ctx, "report", result as DataResult<unknown>);
  const r = result as ResearchReport;
  const s = ctx.style;
  const st = r.stats;
  ctx.out(`${s.bold(`REPORT  ${st?.symbol ?? q.toUpperCase()}`)}  ${st?.name ?? ""}  ${s.dim(r.address)}  ${s.dim(`Robinhood Chain · ${r.generatedAt.slice(0, 16).replace("T", " ")} UTC`)}`);
  if (st) {
    ctx.out(`  price ${usdPrice(st.priceUsd)}  1h ${pct(s, st.changePct.h1)}  24h ${pct(s, st.changePct.h24)}  vol 24h ${usdCompact(st.volumeUsd.h24)}  liquidity ${usdCompact(st.liquidityUsd)}  mcap ${usdCompact(st.marketCapUsd)}`);
    ctx.out(`  holders ${st.holders?.toLocaleString("en-US") ?? "—"}  buys/sells 24h ${st.buys24 ?? "—"}/${st.sells24 ?? "—"}  unique buyers ${st.uniqueBuyers24 ?? "—"}  age ${age(st.createdAt)}`);
  }
  ctx.out(s.bold("\n  flags"));
  const icon = { danger: s.red("✖ DANGER"), warn: s.yellow("▲ WARN  "), info: s.dim("• info  "), ok: s.green("✓ ok    ") } as const;
  for (const f of r.flags) ctx.out(`    ${icon[f.level]}  ${f.text}  ${s.dim(`(${f.source})`)}`);
  const pairs = r.sections.pairs;
  if (pairs && isLive(pairs)) {
    ctx.out(s.bold("\n  pools"));
    for (const p of ((pairs.data as { pairs: Array<any> }).pairs ?? []).slice(0, 5)) ctx.out(`    ${(p.exchange ?? "?").padEnd(12)} vol24h ${usdCompact(p.volumeUsd24h).padStart(8)}  liquidity ${usdCompact(p.liquidityUsd).padStart(8)}  ${s.dim(p.pairAddress ?? "")}`);
  }
  const danger = r.flags.filter((f) => f.level === "danger").length;
  const warn = r.flags.filter((f) => f.level === "warn").length;
  ctx.out(`\n  ${danger ? s.red(`${danger} danger`) : s.green("0 danger")} · ${warn ? s.yellow(`${warn} warnings`) : "0 warnings"} · ${s.dim("flags come from the named provider fields; not financial advice")}`);
  return 0;
}

// ----------------------------------------------------------------------------------------- whales

export async function whalesCommand(ctx: Context, positionals: string[], flags: ProFlags): Promise<number> {
  const q = need(positionals, 1, "splice tokens whales <SYMBOL|address> [--min usd]");
  const minUsd = numFlag(flags.min, "min", 0);
  const result = await dataFor(ctx).tokens.whales(q, { ...fresh(flags), ...(minUsd !== undefined ? { minUsd } : {}) });
  if (ctx.json || !isLive(result)) return emit(ctx, "tokens whales", result as DataResult<unknown>);
  const d = result.data;
  const s = ctx.style;
  ctx.out(`${s.bold(`whales ${d.symbol ?? q.toUpperCase()}`)}  ${statusLine(ctx, result)}`);
  ctx.out(`  ${d.count} trades ≥ $${d.minUsd.toLocaleString("en-US")} in the last ${d.scanned} swaps${d.window ? ` (${d.window.from?.slice(11, 16)}–${d.window.to?.slice(11, 16)} UTC)` : ""}   buys ${s.green(usdCompact(d.buyUsd))}  sells ${s.red(usdCompact(d.sellUsd))}  net ${d.netFlowUsd >= 0 ? s.green(`+${usdCompact(d.netFlowUsd)}`) : s.red(`-${usdCompact(-d.netFlowUsd)}`)}`);
  if (d.trades.length) {
    const rows = d.trades.slice(0, 20).map((t) => [String(t.time ?? "").slice(11, 19), t.type === "Buy" ? s.green("BUY") : s.red("SELL"), usdCompact(t.valueUsd), usdPrice(t.priceUsd), t.maker ?? "—"]);
    for (const l of table(s, ["TIME", "TYPE", "VALUE", "PRICE", "WALLET"], rows, ["left", "left", "right", "right", "left"])) ctx.out(l);
  }
  if (d.wallets.length) {
    ctx.out(s.bold("  biggest wallets in this window"));
    for (const w of d.wallets.slice(0, 5)) ctx.out(`    ${w.wallet}  bought ${s.green(usdCompact(w.buyUsd))}  sold ${s.red(usdCompact(w.sellUsd))}  (${w.trades} trades)`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------- compare

export async function compareCommand(ctx: Context, positionals: string[], flags: ProFlags): Promise<number> {
  if (positionals.length < 2 || positionals.length > 6) throw new UsageError("compare needs 2–6 tokens", "Usage: splice compare <A> <B> [C …]");
  const tokens = dataFor(ctx).tokens;
  const resolved = await Promise.all(positionals.map((q) => tokens.resolve(q, fresh(flags))));
  if (ctx.json) {
    ctx.out(JSON.stringify(resolved, null, 2));
    return 0;
  }
  const s = ctx.style;
  const cols = resolved.map((r, i) => ("status" in r ? { label: positionals[i]!.toUpperCase(), st: undefined as CodexToken | undefined, err: r.status } : { label: r.stats?.symbol ?? positionals[i]!.toUpperCase(), st: r.stats, err: r.stats ? undefined : "no stats" }));
  const row = (name: string, f: (t: CodexToken) => string) => [s.bold(name), ...cols.map((c) => (c.st ? f(c.st) : s.dim(c.err ?? "—")))];
  const rows = [
    row("price", (t) => usdPrice(t.priceUsd)),
    row("1h", (t) => pct(s, t.changePct.h1)),
    row("4h", (t) => pct(s, t.changePct.h4)),
    row("24h", (t) => pct(s, t.changePct.h24)),
    row("volume 24h", (t) => usdCompact(t.volumeUsd.h24)),
    row("liquidity", (t) => usdCompact(t.liquidityUsd)),
    row("market cap", (t) => usdCompact(t.marketCapUsd)),
    row("holders", (t) => t.holders?.toLocaleString("en-US") ?? "—"),
    row("buys/sells 24h", (t) => `${t.buys24 ?? "—"}/${t.sells24 ?? "—"}`),
    row("unique buyers", (t) => String(t.uniqueBuyers24 ?? "—")),
    row("age", (t) => age(t.createdAt)),
  ];
  ctx.out(s.bold("compare  (codex)"));
  for (const l of table(s, ["", ...cols.map((c) => c.label)], rows, ["left", ...cols.map(() => "right" as const)])) ctx.out(l);
  return 0;
}

// -------------------------------------------------------------------------------------- watchlist

interface WatchItem {
  kind: "token" | "perp";
  symbol: string;
  address?: string;
}

function watchlistPath(ctx: Context): string {
  return join(spliceHome(ctx.io.env), "watchlist.json");
}

function readWatchlist(ctx: Context): WatchItem[] {
  const file = watchlistPath(ctx);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { items?: WatchItem[] };
    return Array.isArray(parsed.items) ? parsed.items.filter((i) => (i.kind === "token" || i.kind === "perp") && typeof i.symbol === "string") : [];
  } catch {
    return [];
  }
}

function writeWatchlist(ctx: Context, items: WatchItem[]): void {
  const file = watchlistPath(ctx);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ items }, null, 2) + "\n");
}

export async function watchlistCommand(ctx: Context, positionals: string[], flags: ProFlags): Promise<number> {
  const [sub, ...args] = positionals;
  const s = ctx.style;
  const data = dataFor(ctx);
  const items = readWatchlist(ctx);
  if (sub === "add") {
    if (args.length === 0) throw new UsageError("missing tokens", "Usage: splice watchlist add <SYMBOL|address|perp:SYMBOL> …");
    for (const raw of args) {
      if (/^perp:/i.test(raw)) {
        const symbol = raw.slice(5).toUpperCase();
        if (!items.some((i) => i.kind === "perp" && i.symbol === symbol)) items.push({ kind: "perp", symbol });
        ctx.out(`${s.green("+")} perp ${symbol}`);
        continue;
      }
      const r = await data.tokens.resolve(raw, fresh(flags));
      if ("status" in r) {
        ctx.err(`${s.yellow("–")} ${raw}: ${r.status === "UNAVAILABLE" ? r.reason : r.status === "ERROR" ? r.message : r.status}`);
        continue;
      }
      const symbol = r.stats?.symbol ?? raw.toUpperCase();
      if (!items.some((i) => i.kind === "token" && i.address?.toLowerCase() === r.address.toLowerCase())) items.push({ kind: "token", symbol, address: r.address });
      ctx.out(`${s.green("+")} ${symbol}  ${s.dim(r.address)}`);
    }
    writeWatchlist(ctx, items);
    return 0;
  }
  if (sub === "remove" || sub === "rm") {
    const drop = new Set(args.map((a) => a.toUpperCase().replace(/^PERP:/, "")));
    const kept = items.filter((i) => !drop.has(i.symbol.toUpperCase()) && !drop.has((i.address ?? "").toUpperCase()));
    writeWatchlist(ctx, kept);
    ctx.out(`${items.length - kept.length} removed, ${kept.length} left`);
    return 0;
  }
  if (sub !== undefined && sub !== "show") throw new UsageError(`unknown subcommand "watchlist ${sub}"`, "Usage: splice watchlist [show] | add <token…|perp:SYM> | remove <token…>");
  if (items.length === 0) {
    ctx.out(s.dim("Watchlist is empty. Add with: splice watchlist add PONS NVDA perp:BTC"));
    return 0;
  }
  const tokenItems = items.filter((i) => i.kind === "token");
  const perpItems = items.filter((i) => i.kind === "perp");
  const [stats, perps] = await Promise.all([Promise.all(tokenItems.map((i) => data.tokens.resolve(i.address ?? i.symbol, fresh(flags)))), perpItems.length ? data.perps.markets({ ...fresh(flags), type: "all", limit: 300 }) : Promise.resolve(undefined)]);
  if (ctx.json) {
    ctx.out(JSON.stringify({ tokens: stats, perps }, null, 2));
    return 0;
  }
  ctx.out(s.bold(`watchlist  ${s.dim(watchlistPath(ctx))}`));
  const rows: string[][] = tokenItems.map((i, n) => {
    const r = stats[n]!;
    const t = "status" in r ? undefined : r.stats;
    return [s.bold(i.symbol), "token", usdPrice(t?.priceUsd), pct(s, t?.changePct.h1), pct(s, t?.changePct.h24), usdCompact(t?.volumeUsd.h24), usdCompact(t?.liquidityUsd), "codex"];
  });
  for (const p of perpItems) {
    const m = perps && isLive(perps) ? (perps.data.markets as Array<any>).find((x) => x.symbol.toUpperCase() === p.symbol) : undefined;
    rows.push([s.bold(p.symbol), "perp", usdPrice(m?.markPrice ?? m?.lastPrice), "—", pct(s, m?.change24hPct), usdCompact(m?.volume24hUsd), usdCompact(m?.openInterestUsd), "lighter"]);
  }
  for (const l of table(s, ["SYMBOL", "KIND", "PRICE", "1H", "24H", "VOL 24H", "LIQ / OI", "SOURCE"], rows, ["left", "left", "right", "right", "right", "right", "right", "left"])) ctx.out(l);
  return 0;
}

// ------------------------------------------------------------------------------------ watch/radar

async function loop(ctx: Context, flags: ProFlags, defaultSeconds: number, tick: (n: number) => Promise<void>): Promise<number> {
  const seconds = numFlag(flags.interval, "interval", 15) ?? defaultSeconds;
  const count = numFlag(flags.count, "count", 1);
  ctx.err(ctx.style.dim(`refreshing every ${seconds}s${count ? ` × ${count}` : ""} · Ctrl+C to stop · each refresh uses provider quota (Codex free plan: 10,000 requests/month)`));
  for (let n = 1; count === undefined || n <= count; n++) {
    await tick(n);
    if (count !== undefined && n >= count) break;
    await sleep(seconds * 1000);
  }
  return 0;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const bell = (ctx: Context) => ctx.io.stdout("\u0007");

export async function watchCommand(ctx: Context, positionals: string[], flags: ProFlags): Promise<number> {
  const s = ctx.style;
  const data = dataFor(ctx);
  const [first, second] = positionals;
  if (!first) throw new UsageError("missing token", "Usage: splice watch <SYMBOL|address> [--above p] [--below p] [--change pct] | splice watch whales <token> [--min usd] [--interval s]");
  if (first === "whales") {
    const q = need(positionals, 1, "splice watch whales <SYMBOL|address> [--min usd]");
    const minUsd = numFlag(flags.min, "min", 0) ?? 5_000;
    const seen = new Set<string>();
    return loop(ctx, flags, 30, async (n) => {
      const r = await data.tokens.whales(q, { fresh: true, minUsd });
      if (!isLive(r)) return ctx.out(`${stamp()}  ${statusLine(ctx, r as DataResult<unknown>)}`);
      const fresh = r.data.trades.filter((t) => t.txHash && !seen.has(`${t.txHash}:${t.maker}`)).reverse();
      for (const t of r.data.trades) if (t.txHash) seen.add(`${t.txHash}:${t.maker}`);
      if (n === 1) return ctx.out(`${stamp()}  watching ${s.bold(r.data.symbol ?? q.toUpperCase())} for trades ≥ $${minUsd.toLocaleString("en-US")} · last ${r.data.scanned} swaps had ${r.data.count} (net ${usdCompact(r.data.netFlowUsd)})`);
      for (const t of fresh) {
        bell(ctx);
        ctx.out(`${stamp()}  ${s.bold("🐋 WHALE")} ${t.type === "Buy" ? s.green("BUY ") : s.red("SELL")} ${usdCompact(t.valueUsd)} @ ${usdPrice(t.priceUsd)}  ${s.dim(t.maker ?? "")}`);
      }
    });
  }
  const above = numFlag(flags.above, "above", 0);
  const below = numFlag(flags.below, "below", 0);
  const change = numFlag(flags.change, "change", 0);
  void second;
  let base: number | undefined;
  const fired = new Set<string>();
  return loop(ctx, flags, 60, async () => {
    const r = await data.tokens.resolve(first, { fresh: true });
    if ("status" in r || !r.stats) return ctx.out(`${stamp()}  ${first.toUpperCase()}  ${"status" in r ? (r.status === "UNAVAILABLE" ? r.reason : r.status === "ERROR" ? r.message : r.status) : "no stats"}`);
    const t = r.stats;
    const price = Number(t.priceUsd);
    base ??= price;
    const moved = base ? ((price - base) / base) * 100 : 0;
    const alerts: string[] = [];
    const once = (key: string, text: string) => {
      if (!fired.has(key)) {
        fired.add(key);
        alerts.push(text);
      }
    };
    if (above !== undefined && price >= above) once("above", `price ≥ ${usdPrice(above)}`);
    if (below !== undefined && price <= below) once("below", `price ≤ ${usdPrice(below)}`);
    if (change !== undefined && Math.abs(moved) >= change) once(`change:${Math.sign(moved)}`, `moved ${moved > 0 ? "+" : ""}${moved.toFixed(2)}% since watch start`);
    ctx.out(`${stamp()}  ${s.bold(t.symbol ?? first.toUpperCase())}  ${usdPrice(t.priceUsd)}  1h ${pct(s, t.changePct.h1)}  24h ${pct(s, t.changePct.h24)}  vol ${usdCompact(t.volumeUsd.h24)}  liq ${usdCompact(t.liquidityUsd)}  ${s.dim(`since start ${moved >= 0 ? "+" : ""}${moved.toFixed(2)}%`)}`);
    for (const a of alerts) {
      bell(ctx);
      ctx.out(`         ${s.bold(s.yellow("🔔 ALERT"))} ${a}`);
    }
  });
}

export async function radarCommand(ctx: Context, _positionals: string[], flags: ProFlags): Promise<number> {
  const s = ctx.style;
  const data: SpliceData = dataFor(ctx);
  const minLiquidity = numFlag(flags.minLiquidity, "min-liquidity", 0) ?? 5_000;
  const seen = new Set<string>();
  return loop(ctx, flags, 60, async (n) => {
    const r = await data.tokens.rank("new", { fresh: true, minLiquidity, limit: 20 });
    if (!isLive(r)) return ctx.out(`${stamp()}  ${statusLine(ctx, r)}`);
    const fresh = r.data.tokens.filter((t) => !seen.has(t.address.toLowerCase()));
    for (const t of r.data.tokens) seen.add(t.address.toLowerCase());
    if (n === 1) ctx.out(`${stamp()}  radar: new Robinhood Chain tokens with liquidity ≥ $${minLiquidity.toLocaleString("en-US")} (security checks by GoPlus)`);
    for (const t of fresh.slice(0, n === 1 ? 8 : 20).reverse()) {
      // Quick security check for each new token (GoPlus); failures are shown, not hidden.
      const sec = await data.security.token(t.address, { fresh: true });
      const rep = isLive(sec) ? (((sec.data as { report?: Record<string, any> }).report ?? {}) as Record<string, any>) : undefined;
      const tags: string[] = [];
      if (rep) {
        if (rep.is_honeypot === "1") tags.push(s.red("HONEYPOT"));
        const sellTax = Number(rep.sell_tax ?? 0) * 100;
        if (sellTax >= 10) tags.push(s.red(`sell tax ${sellTax.toFixed(0)}%`));
        if (rep.is_mintable === "1") tags.push(s.yellow("mintable"));
        if (rep.hidden_owner === "1") tags.push(s.red("hidden owner"));
        if (tags.length === 0) tags.push(s.green("no GoPlus flags"));
      } else tags.push(s.dim("security: n/a"));
      if (n > 1) bell(ctx);
      ctx.out(`${stamp()}  ${s.bold("✦ NEW")} ${s.bold(truncate(t.symbol, 12))}  ${usdPrice(t.priceUsd)}  liq ${usdCompact(t.liquidityUsd)}  vol ${usdCompact(t.volumeUsd.h24)}  holders ${t.holders ?? "—"}  age ${age(t.createdAt)}  ${tags.join(" ")}  ${s.dim(t.address)}`);
    }
  });
}
