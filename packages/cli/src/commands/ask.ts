/**
 * `splice ask "<question>"` and `splice chat`: a research agent over Splice's live data.
 *
 * The configured model (OpenRouter by default) gets Splice's read-only data tools — market, onchain,
 * wallet, security, stocks, oracle prices, web and GitHub — decides which to call, and answers from
 * the results. Every number in an answer comes from a tool result with its provider; the model is
 * told never to answer market or chain facts from memory. Tool calls are shown as they happen, and
 * the provider-reported cost of every model call is summed.
 */
import { createInterface } from "node:readline";
import { isLive, type AiMessage, type AiTool, type SpliceData } from "@spliceloom/data";
import { DATA_TOOLS } from "@spliceloom/mcp";
import { redactSecrets, validateValue } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { dataFor, statusLine } from "./data.js";
import { renderMarkdown } from "../format.js";

export interface AskFlags {
  model?: string;
  provider?: string;
  maxTokens?: string;
}

/** Tools the agent may not call (no model calling models). */
const EXCLUDED = new Set(["ai_generate", "ai_models"]);
const MAX_STEPS = 8;
/** Characters of one tool result passed back to the model. */
const RESULT_BUDGET = 9_000;

export function agentTools(): AiTool[] {
  return DATA_TOOLS.filter((t) => !EXCLUDED.has(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.input as Record<string, unknown> }));
}

function systemPrompt(now = new Date()): string {
  return [
    `You are Splice, a live-data research assistant running in a developer's terminal. Current time: ${now.toISOString()} (UTC).`,
    'Default chain: Robinhood Chain mainnet — chain key "robinhood", chain id 4663, an EVM Layer 2 with gas paid in ETH. For DEX market tools use network "robinhood" unless the user names another network.',
    "Rules:",
    "- For any price, market, token, wallet, transaction, stock, oracle, web or GitHub fact, call the tools. Never answer such facts from memory and never invent numbers, addresses, tickers or URLs.",
    "- Each tool result has a status (LIVE, CACHED, UNAVAILABLE, ERROR) and provenance (source = provider). If a result is UNAVAILABLE or ERROR, say so plainly and try another relevant tool if one exists.",
    "- Use few, targeted calls; you may call several tools in one step. For 'is this token safe / research X' use token_report; for big buyers/sellers use token_whales. For Robinhood Chain tokens prefer tokens_rank (trending, hot, new, gainers, losers, volume, holders, mcap) and token_details/token_trades/token_chart (Codex, all tokens); market_movers/market_trending are DEX-pool views. Global markets: global_overview, global_coins, global_stocks. Perps (incl. Robinhood Wallet perps): perps_markets, perps_funding. Companies: stock_profile, stock_news, earnings_calendar, us_market_status. Macro: macro_overview, macro_series. News: market_news. DeFi: defi_*. Stock tokens: stock_quote, stock_movers.",
    "- Answer concisely and concretely: short tables or bullet lists for rankings, key numbers with units and percentages, token symbols with their address when useful.",
    "- Always name the sources you used — the provider in each result`s provenance.source (e.g. coingecko, geckoterminal, dexscreener, chainlink, alchemy, blockscout, tavily) — and the data time (provenance.fetchedAt). Links in the data are just links, not the source.",
    "- Respect units exactly as the data names them: fields ending in Pct / percent are already percentages (0.0096 means 0.0096%, never multiply by 100); Codex price changes are already converted to percent.",
    "- For yields, consider pool TVL: very high APYs on tiny pools are usually unsustainable; filter stablecoin pools with stablecoin=true when the user asks about stablecoins.",
    "- Market data is not financial advice. Do not tell the user what to buy or sell; if asked, give the data and a one-line risk note.",
    "- Reply in the same language the user writes in.",
  ].join("\n");
}

/** Shortens a tool result for the model: long lists, bulky fields and long strings are trimmed. */
export function forModel(value: unknown, budget = RESULT_BUDGET): string {
  const trim = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) {
      const items = v.slice(0, depth === 0 ? 25 : 15).map((x) => trim(x, depth + 1));
      return v.length > items.length ? [...items, `(${v.length - items.length} more not shown)`] : items;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (["abi", "bytecode", "source_code", "trace", "rawTrace", "stateChanges"].includes(k)) continue;
        out[k] = trim(x, depth + 1);
      }
      return out;
    }
    if (typeof v === "string" && v.length > 600) return `${v.slice(0, 600)}…`;
    return v;
  };
  let text = JSON.stringify(trim(value, 0));
  if (text.length > budget) text = `${text.slice(0, budget)}… (truncated)`;
  return text;
}

interface Turn {
  answer: string;
  calls: Array<{ name: string; args: Record<string, unknown>; status: string; source?: string }>;
  costUsd: number;
  model?: string;
}

async function runTool(data: SpliceData, name: string, rawArgs: string): Promise<{ args: Record<string, unknown>; result: unknown; status: string; source?: string }> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return { args, result: { status: "ERROR", code: "INVALID_INPUT", message: "arguments were not valid JSON" }, status: "ERROR" };
  }
  const tool = DATA_TOOLS.find((t) => t.name === name && !EXCLUDED.has(t.name));
  if (!tool) return { args, result: { status: "ERROR", code: "UNKNOWN_TOOL", message: `no tool named ${name}` }, status: "ERROR" };
  const errors = validateValue(tool.input, args, "input");
  if (errors.length > 0) return { args, result: { status: "ERROR", code: "INVALID_INPUT", message: errors.join("; ") }, status: "ERROR" };
  try {
    const result = await tool.run(data, args);
    const r = result as { status?: string; kind?: string; provenance?: { source?: string }; sections?: Record<string, { status?: string; provenance?: { source?: string } }> };
    if (r?.kind === "composite") {
      const sources = [...new Set(Object.values(r.sections ?? {}).flatMap((s) => (s.provenance?.source ? [s.provenance.source] : [])))];
      const out: { args: Record<string, unknown>; result: unknown; status: string; source?: string } = { args, result, status: sources.length ? "LIVE" : "UNAVAILABLE" };
      if (sources.length) out.source = sources.join(",");
      return out;
    }
    const out: { args: Record<string, unknown>; result: unknown; status: string; source?: string } = { args, result, status: Array.isArray(result) ? "LIVE" : (r?.status ?? "LIVE") };
    if (r?.provenance?.source) out.source = r.provenance.source;
    return out;
  } catch (error) {
    return { args, result: { status: "ERROR", message: redactSecrets(String((error as Error)?.message ?? error), data.env.secrets) }, status: "ERROR" };
  }
}

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== "fresh")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/** One question → tool calls → answer. `messages` carries the conversation (chat mode). */
async function turn(ctx: Context, data: SpliceData, messages: AiMessage[], flags: AskFlags, progress: boolean): Promise<Turn | { error: string }> {
  const tools = agentTools();
  const calls: Turn["calls"] = [];
  let costUsd = 0;
  let model: string | undefined;
  const maxTokens = flags.maxTokens !== undefined ? Number(flags.maxTokens) : 1_500;
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 16_000) throw new UsageError("--max-tokens must be an integer between 64 and 16000");
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const input: Parameters<SpliceData["ai"]["generate"]>[0] = { messages, tools, toolChoice: last ? "none" : "auto", maxTokens, temperature: 0.2 };
    const askModel = flags.model ?? data.env.values.AI_ASK_MODEL;
    if (askModel) input.model = askModel;
    if (flags.provider) input.provider = flags.provider;
    const result = await data.ai.generate(input);
    if (!isLive(result)) return { error: statusLine(ctx, result) };
    costUsd += result.data.usage?.costUsd ?? 0;
    model = result.data.routing.actualModel;
    const toolCalls = result.data.toolCalls ?? [];
    if (toolCalls.length === 0 || last) {
      const answer = result.data.text?.trim() ?? "";
      messages.push({ role: "assistant", content: answer });
      const out: Turn = { answer, calls, costUsd };
      if (model) out.model = model;
      return out;
    }
    messages.push({ role: "assistant", content: result.data.text ?? "", toolCalls });
    const results = await Promise.all(toolCalls.map((c) => runTool(data, c.name, c.arguments)));
    toolCalls.forEach((c, i) => {
      const r = results[i]!;
      const call: Turn["calls"][number] = { name: c.name, args: r.args, status: r.status };
      if (r.source) call.source = r.source;
      calls.push(call);
      if (progress) {
        const mark = r.status === "LIVE" || r.status === "CACHED" ? ctx.style.green("✓") : ctx.style.yellow("–");
        ctx.err(ctx.style.dim(`  ${mark} ${c.name}  ${describeArgs(r.args)}  → ${r.status}${r.source ? ` ${r.source}` : ""}`));
      }
      const msg: AiMessage = { role: "tool", content: forModel(r.result), name: c.name };
      if (c.id) msg.toolCallId = c.id;
      messages.push(msg);
    });
  }
  return { error: "no answer" };
}

function printTurn(ctx: Context, t: Turn): void {
  ctx.out(t.answer ? renderMarkdown(ctx.style, t.answer) : ctx.style.dim("(no answer)"));
  const sources = [...new Set(t.calls.flatMap((c) => (c.source ? c.source.split(",") : [])))];
  ctx.err(ctx.style.dim(`  ${t.calls.length} tool call${t.calls.length === 1 ? "" : "s"}${sources.length ? ` · sources: ${sources.join(", ")}` : ""} · model ${t.model ?? "?"} · cost ${t.costUsd.toFixed(6)} USD · not financial advice`));
}

export async function askCommand(ctx: Context, positionals: string[], flags: AskFlags): Promise<number> {
  const question = positionals.join(" ").trim();
  if (!question) {
    if (ctx.io.stdin && (ctx.io.stdin as { isTTY?: boolean }).isTTY) return chatCommand(ctx, [], flags);
    throw new UsageError("missing question", 'Usage: splice ask "<question>"   (or `splice chat` for a conversation)');
  }
  const data = dataFor(ctx);
  const messages: AiMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: question },
  ];
  const t = await turn(ctx, data, messages, flags, !ctx.json);
  if ("error" in t) {
    if (ctx.json) ctx.out(JSON.stringify({ status: "ERROR", error: t.error }, null, 2));
    else ctx.err(`${ctx.style.red("ask failed:")} ${t.error}`);
    return 1;
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ question, answer: t.answer, toolCalls: t.calls, model: t.model, costUsd: t.costUsd }, null, 2));
    return 0;
  }
  printTurn(ctx, t);
  return 0;
}

export async function chatCommand(ctx: Context, positionals: string[], flags: AskFlags): Promise<number> {
  if (!ctx.io.stdin) throw new UsageError("chat needs an interactive terminal", 'Use: splice ask "<question>"');
  const data = dataFor(ctx);
  const messages: AiMessage[] = [{ role: "system", content: systemPrompt() }];
  const s = ctx.style;
  ctx.err(`${s.bold("Splice chat")} ${s.dim("— live data from Robinhood Chain, DEX markets, stocks, oracles, web and GitHub. Type a question; \"exit\" to quit.")}`);
  const rl = createInterface({ input: ctx.io.stdin, terminal: false });
  const prompt = () => ctx.io.stderr(s.cyan("\n› "));
  const first = positionals.join(" ").trim();
  const ask = async (line: string): Promise<void> => {
    messages.push({ role: "user", content: line });
    const t = await turn(ctx, data, messages, flags, true);
    if ("error" in t) {
      messages.pop();
      ctx.err(`${s.red("failed:")} ${t.error}`);
      return;
    }
    printTurn(ctx, t);
  };
  if (first) await ask(first);
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (/^(exit|quit|keluar|:q)$/i.test(line)) break;
    await ask(line);
    // Keep the conversation bounded: system prompt + the last 30 messages.
    if (messages.length > 31) messages.splice(1, messages.length - 31);
    prompt();
  }
  rl.close();
  return 0;
}
