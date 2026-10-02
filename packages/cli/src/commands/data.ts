/**
 * Live data commands: chain, providers, block, tx, wallet, token, contract, logs, price, security.
 * Every command queries real providers through @spliceloom/data and prints each result with its
 * status (LIVE / CACHED / UNAVAILABLE / ERROR) and provenance. Nothing is invented or defaulted.
 *
 * Exit codes: 0 = data returned (LIVE or CACHED); 3 = UNAVAILABLE; 1 = ERROR; 2 = usage.
 */
import { SpliceData, isLive, resolveChain, type CallOptions, type Composite, type DataResult, type ProviderStatus } from "@spliceloom/data";
import { UsageError, type Context } from "../io.js";
import { printJson } from "./shared.js";

export interface DataFlags {
  chain?: string;
  fresh?: boolean;
  limit?: string;
  address?: string;
  fromBlock?: string;
  toBlock?: string;
  topic?: string[];
  vs?: string;
}

export const EXIT_UNAVAILABLE = 3;

export function dataFor(ctx: Context): SpliceData {
  // Provider keys come only from the whitelisted provider variables (env, then .env.local / .env).
  return new SpliceData({ env: ctx.io.env, cwd: ctx.io.cwd, ...(ctx.io.dataFetch ? { fetch: ctx.io.dataFetch } : {}) });
}

function callOptions(flags: DataFlags): CallOptions {
  const options: CallOptions = {};
  if (flags.chain !== undefined) options.chain = flags.chain;
  if (flags.fresh) options.fresh = true;
  return options;
}

/** Human output omits bulky fields (ABI, bytecode, sources) and long lists; --json prints everything. */
function compact(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 10).map((v) => compact(v, depth + 1));
    return value.length > 10 ? [...shown, `… ${value.length - 10} more (use --json)`] : shown;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "abi") out[k] = Array.isArray(v) ? `[${v.length} entries, use --json]` : v;
      else if (k === "bytecode" && typeof v === "string" && v.length > 66) out[k] = `${v.slice(0, 42)}… (${(v.length - 2) / 2} bytes, use --json)`;
      else if ((k === "trace" || k === "source_code") && depth > 0) out[k] = "(use --json)";
      else out[k] = compact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function statusLine(ctx: Context, r: DataResult<unknown>): string {
  const s = ctx.style;
  if (isLive(r)) {
    const p = r.provenance;
    const parts = [`source=${p.source}`, p.chainId === null ? `scope=${p.chain}` : `chain=${p.chain}(${p.chainId})`];
    if (p.blockNumber) parts.push(`block=${p.blockNumber}`);
    if (p.resource) parts.push(`resource=${p.resource}`);
    parts.push(`fetched=${p.fetchedAt}`);
    if (p.fallbackFrom?.length) parts.push(`fallback-from=${p.fallbackFrom.map((f) => f.provider).join(",")}`);
    if (r.status === "CACHED") return `${s.yellow("○ CACHED")}  ${parts.join("  ")}  age=${Math.round((p.cache?.ageMs ?? 0) / 1000)}s (not live; --fresh to refetch)`;
    return `${s.green("● LIVE")}  ${parts.join("  ")}`;
  }
  if (r.status === "UNAVAILABLE") return `${s.yellow("– UNAVAILABLE")}  ${r.code}${r.provider ? ` (${r.provider})` : ""}: ${r.reason}`;
  return `${s.red("✗ ERROR")}  ${r.code}: ${r.message}`;
}

function printResult(ctx: Context, label: string, r: DataResult<unknown>, indent = ""): void {
  ctx.out(`${indent}${ctx.style.bold(label)}  ${statusLine(ctx, r)}`);
  if (isLive(r)) {
    for (const note of r.provenance.notes ?? []) ctx.out(`${indent}  ${ctx.style.dim(`note: ${note}`)}`);
    const text = JSON.stringify(compact(r.data), null, 2);
    for (const line of text.split("\n")) ctx.out(`${indent}  ${line}`);
  } else if (r.status === "UNAVAILABLE") {
    for (const p of r.providers ?? []) ctx.out(`${indent}  ${ctx.style.dim(`- ${p.provider}: ${p.reason}`)}`);
    const reasons = [r.reason, ...(r.providers ?? []).map((p) => p.reason)].join(" ");
    if (/is not set|are not set|needs [A-Z_]+_KEY/.test(reasons)) ctx.out(`${indent}  ${ctx.style.dim("hint: run `splice setup` to see which key enables this and where to get one (most have free tiers)")}`);
  } else {
    for (const a of r.attempts) ctx.out(`${indent}  ${ctx.style.dim(`- ${a.provider}: ${a.error}`)}`);
  }
}

export function exitFor(result: DataResult<unknown> | Composite): number {
  if ("kind" in result) {
    const statuses = Object.values(result.sections).map((s) => s.status);
    if (statuses.some((s) => s === "LIVE" || s === "CACHED")) return 0;
    return statuses.some((s) => s === "ERROR") ? 1 : EXIT_UNAVAILABLE;
  }
  if (isLive(result)) return 0;
  if (result.status === "UNAVAILABLE") return EXIT_UNAVAILABLE;
  return result.code === "INVALID_INPUT" ? 2 : 1;
}

export function emit(ctx: Context, label: string, result: DataResult<unknown> | Composite): number {
  if (ctx.json) {
    printJson(ctx, result);
    return exitFor(result);
  }
  if ("kind" in result) {
    ctx.out(`${ctx.style.bold(label)} ${result.subject}  ${result.chainId === null ? `network=${result.chain}` : `chain=${result.chain}(${result.chainId})`}  generated=${result.generatedAt}`);
    for (const [name, section] of Object.entries(result.sections)) printResult(ctx, name, section, "  ");
  } else {
    printResult(ctx, label, result);
  }
  return exitFor(result);
}

export function need(positionals: string[], index: number, usage: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing argument`, `Usage: ${usage}`);
  return value;
}

export async function chainCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  const sub = positionals[0] ?? "list";
  const data = dataFor(ctx);
  if (sub === "list") {
    const chains = data.chains.list();
    if (ctx.json) {
      printJson(ctx, chains);
      return 0;
    }
    for (const c of chains) ctx.out(`${c.key.padEnd(20)} chainId=${String(c.chainId).padEnd(6)} ${c.network.padEnd(8)} native=${c.nativeCurrency.symbol}${c.default ? "  (default)" : ""}`);
    return 0;
  }
  if (sub === "info") return emit(ctx, "chain", await data.chains.info({ ...callOptions(flags), ...(positionals[1] ? { chain: positionals[1] } : {}) }));
  throw new UsageError(`unknown subcommand "chain ${sub}"`, "Usage: splice chain list | splice chain info [chain]");
}

/**
 * `splice providers` / `splice provider health`: live checks. `splice provider list`: the registered
 * providers and their configuration state without any request.
 */
export async function providersCommand(ctx: Context, positionals: string[], flags: DataFlags, mode: "health" | "list" = "health"): Promise<number> {
  if (positionals.length > 0) throw new UsageError("unexpected arguments", "Usage: splice providers | splice provider list | splice provider health [--chain <chain>] [--json]");
  const data = dataFor(ctx);
  const rows: ProviderStatus[] = mode === "list" ? data.providers.list() : await data.providers.check(flags.chain !== undefined ? { chain: flags.chain } : {});
  if (mode === "list") {
    if (ctx.json) printJson(ctx, rows);
    else for (const r of rows) ctx.out(`${r.provider.padEnd(22)} ${(r.configured ? "configured" : "not_configured").padEnd(15)} ${r.kind.padEnd(10)} ${r.chains.join(",").padEnd(28)} ${ctx.style.dim(r.auth)}`);
    return 0;
  }
  if (ctx.json) {
    printJson(ctx, rows);
    return rows.some((r) => r.status === "healthy") ? 0 : 1;
  }
  const s = ctx.style;
  const color = (st: string) => (st === "healthy" ? s.green(st) : st === "not_configured" ? s.dim(st) : st === "degraded" ? s.yellow(st) : s.red(st));
  ctx.out(s.bold(`${"provider".padEnd(22)} ${"status".padEnd(15)} ${"latency".padStart(8)}  ${"checked".padEnd(8)}  scope / capabilities`));
  for (const r of rows) {
    const checked = r.lastCheckedAt ? r.lastCheckedAt.slice(11, 19) : "-";
    ctx.out(`${r.provider.padEnd(22)} ${color(r.status.padEnd(15))} ${(r.latencyMs === null ? "-" : `${r.latencyMs}ms`).padStart(8)}  ${checked.padEnd(8)}  ${r.chains.join(",")}  ${s.dim(r.capabilities.join(", "))}`);
    if (r.detail || r.lastError) ctx.out(`${"".padEnd(22)} ${s.dim(`${r.status === "healthy" ? "check" : "last error"}: ${r.status === "healthy" ? r.detail : r.lastError}`)}`);
    if (r.lastSuccessAt && r.status !== "healthy") ctx.out(`${"".padEnd(22)} ${s.dim(`last success: ${r.lastSuccessAt}`)}`);
    const missing = r.envVars.filter((v) => !v.set).map((v) => v.name);
    if (r.status === "not_configured" && missing.length) ctx.out(`${"".padEnd(22)} ${s.dim(`set: ${missing.join(" or ")}`)}`);
  }
  ctx.out(s.dim("Checks are live requests; keys are read only from the provider environment variables."));
  return rows.some((r) => r.status === "healthy") ? 0 : 1;
}

export async function blockCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  const sub = positionals[0] ?? "latest";
  const data = dataFor(ctx);
  if (sub === "latest") return emit(ctx, "block", await data.onchain.latestBlock(callOptions(flags)));
  if (sub === "get") return emit(ctx, "block", await data.onchain.block(need(positionals, 1, "splice block get <number|hash>"), callOptions(flags)));
  throw new UsageError(`unknown subcommand "block ${sub}"`, "Usage: splice block latest | splice block get <number|hash>");
}

export async function txCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  if (positionals[0] !== "inspect") throw new UsageError("Usage: splice tx inspect <hash>");
  const hash = need(positionals, 1, "splice tx inspect <hash>");
  const data = dataFor(ctx);
  const options = callOptions(flags);
  const chain = resolveChain(flags.chain);
  if (!chain) return emit(ctx, "tx", await data.chains.info(options));
  const [transaction, explorer, trace] = await Promise.all([data.onchain.transaction(hash, options), data.onchain.indexedTransaction(hash, options), data.onchain.trace(hash, options)]);
  const composite: Composite = { kind: "composite", subject: hash, chain: chain.key, chainId: chain.chainId, generatedAt: new Date().toISOString(), sections: { transaction, explorer, trace } };
  return emit(ctx, "tx", composite);
}

export async function walletCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  const [sub, address] = positionals;
  const usage = "splice wallet inspect|balances|transfers|portfolio <address>";
  if (!sub || !address) throw new UsageError("missing arguments", `Usage: ${usage}`);
  const data = dataFor(ctx);
  const options = callOptions(flags);
  if (sub === "inspect") return emit(ctx, "wallet", await data.wallet.inspect(address, options));
  if (sub === "balances") return emit(ctx, "wallet", await data.wallet.balances(address, options));
  if (sub === "transfers") return emit(ctx, "transfers", await data.wallet.transfers(address, { ...options, ...(flags.limit ? { limit: Number(flags.limit) } : {}) }));
  if (sub === "portfolio") return emit(ctx, "portfolio", await data.wallet.portfolio(address, options));
  throw new UsageError(`unknown subcommand "wallet ${sub}"`, `Usage: ${usage}`);
}

export async function tokenCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  if (positionals[0] !== "inspect") throw new UsageError("Usage: splice token inspect <address>");
  return emit(ctx, "token", await dataFor(ctx).onchain.token(need(positionals, 1, "splice token inspect <address>"), callOptions(flags)));
}

export async function contractCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  if (positionals[0] !== "inspect") throw new UsageError("Usage: splice contract inspect <address>");
  return emit(ctx, "contract", await dataFor(ctx).onchain.contract(need(positionals, 1, "splice contract inspect <address>"), callOptions(flags)));
}

export async function logsCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  if (positionals[0] !== "query") throw new UsageError("Usage: splice logs query [--address <a>] [--from-block <n>] [--to-block <n>] [--topic <t>]...");
  const filter: { address?: string; fromBlock?: string; toBlock?: string; topics?: Array<string | null> } = {};
  if (flags.address) filter.address = flags.address;
  if (flags.fromBlock) filter.fromBlock = flags.fromBlock;
  if (flags.toBlock) filter.toBlock = flags.toBlock;
  if (flags.topic?.length) filter.topics = flags.topic.map((t) => (t === "null" || t === "*" ? null : t));
  return emit(ctx, "logs", await dataFor(ctx).onchain.logs(filter, callOptions(flags)));
}

export async function priceCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  const token = need(positionals, 0, "splice price <ETH|token-address> [--vs usd]");
  return emit(ctx, "price", await dataFor(ctx).market.price(token, { ...callOptions(flags), ...(flags.vs ? { vs: flags.vs } : {}) }));
}

export async function securityCommand(ctx: Context, positionals: string[], flags: DataFlags): Promise<number> {
  const [sub, address] = positionals;
  if (!sub || !address) throw new UsageError("missing arguments", "Usage: splice security token|address|approvals <address>");
  const data = dataFor(ctx);
  if (sub === "token") return emit(ctx, "security", await data.security.token(address, callOptions(flags)));
  if (sub === "address") return emit(ctx, "security", await data.security.address(address, callOptions(flags)));
  if (sub === "approvals") return emit(ctx, "approvals", await data.security.approvals(address, callOptions(flags)));
  throw new UsageError(`unknown subcommand "security ${sub}"`, "Usage: splice security token|address|approvals <address>");
}
