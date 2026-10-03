/**
 * The research agent behind `splice ask`, `splice chat` and the hosted Ask endpoint.
 *
 * The configured model (OpenRouter by default) gets Splice's read-only data tools, decides which to
 * call, and answers from the results. Every number in an answer comes from a tool result with its
 * provider; the model is told never to answer market or chain facts from memory. The provider-reported
 * cost of every model call is summed. No Node.js-only APIs: this module also runs in Workers.
 */
import { isLive, type AiMessage, type AiTool, type DataResult, type SpliceData } from "@spliceloom/data";
import { redactSecrets, validateValue } from "@spliceloom/spec";
import { DATA_TOOLS } from "./data-tools.js";

/** Tools the agent may never call (no model calling models). */
export const AGENT_EXCLUDED: ReadonlySet<string> = new Set(["ai_generate", "ai_models"]);
/** Characters of one tool result passed back to the model. */
const RESULT_BUDGET = 9_000;

export interface AgentCall {
  name: string;
  args: Record<string, unknown>;
  status: string;
  source?: string;
}

export interface AgentTurn {
  answer: string;
  calls: AgentCall[];
  costUsd: number;
  model?: string;
}

export interface AgentOptions {
  model?: string;
  provider?: string;
  maxTokens?: number;
  /** Model round trips before the agent must answer (default 8). */
  maxSteps?: number;
  /** Extra tool names to withhold (in addition to AGENT_EXCLUDED). */
  exclude?: Iterable<string>;
  /** Called as each tool result arrives. */
  onCall?: (call: AgentCall) => void;
}

function allowed(exclude?: Iterable<string>): (name: string) => boolean {
  const extra = new Set(exclude ?? []);
  return (name) => !AGENT_EXCLUDED.has(name) && !extra.has(name);
}

export function agentTools(exclude?: Iterable<string>): AiTool[] {
  const ok = allowed(exclude);
  return DATA_TOOLS.filter((t) => ok(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.input as Record<string, unknown> }));
}

export function agentSystemPrompt(now = new Date(), where = "a developer's terminal"): string {
  return [
    `You are Splice, a live-data research assistant running in ${where}. Current time: ${now.toISOString()} (UTC).`,
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

async function runTool(data: SpliceData, ok: (name: string) => boolean, name: string, rawArgs: string): Promise<{ call: AgentCall; result: unknown }> {
  let args: Record<string, unknown> = {};
  const done = (result: unknown, status: string, source?: string) => ({ call: { name, args, status, ...(source ? { source } : {}) }, result });
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return done({ status: "ERROR", code: "INVALID_INPUT", message: "arguments were not valid JSON" }, "ERROR");
  }
  const tool = DATA_TOOLS.find((t) => t.name === name && ok(t.name));
  if (!tool) return done({ status: "ERROR", code: "UNKNOWN_TOOL", message: `no tool named ${name}` }, "ERROR");
  const errors = validateValue(tool.input, args, "input");
  if (errors.length > 0) return done({ status: "ERROR", code: "INVALID_INPUT", message: errors.join("; ") }, "ERROR");
  try {
    const result = await tool.run(data, args);
    const r = result as { status?: string; kind?: string; provenance?: { source?: string }; sections?: Record<string, { status?: string; provenance?: { source?: string } }> };
    if (r?.kind === "composite") {
      const sources = [...new Set(Object.values(r.sections ?? {}).flatMap((s) => (s.provenance?.source ? [s.provenance.source] : [])))];
      return done(result, sources.length ? "LIVE" : "UNAVAILABLE", sources.join(",") || undefined);
    }
    return done(result, Array.isArray(result) ? "LIVE" : (r?.status ?? "LIVE"), r?.provenance?.source);
  } catch (error) {
    return done({ status: "ERROR", message: redactSecrets(String((error as Error)?.message ?? error), data.env.secrets) }, "ERROR");
  }
}

/**
 * One question → tool calls → answer. `messages` carries the conversation and is extended in place.
 * Returns the model failure (UNAVAILABLE / ERROR result) when the model itself cannot be reached.
 */
export async function runAgentTurn(data: SpliceData, messages: AiMessage[], options: AgentOptions = {}): Promise<AgentTurn | { failure: DataResult<unknown> } | { error: string }> {
  const ok = allowed(options.exclude);
  const tools = agentTools(options.exclude);
  const maxSteps = options.maxSteps ?? 8;
  const calls: AgentCall[] = [];
  let costUsd = 0;
  let model: string | undefined;
  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1;
    const input: Parameters<SpliceData["ai"]["generate"]>[0] = { messages, tools, toolChoice: last ? "none" : "auto", maxTokens: options.maxTokens ?? 1_500, temperature: 0.2 };
    const askModel = options.model ?? data.env.values.AI_ASK_MODEL;
    if (askModel) input.model = askModel;
    if (options.provider) input.provider = options.provider;
    const result = await data.ai.generate(input);
    if (!isLive(result)) return { failure: result };
    costUsd += result.data.usage?.costUsd ?? 0;
    model = result.data.routing.actualModel;
    const toolCalls = result.data.toolCalls ?? [];
    if (toolCalls.length === 0 || last) {
      const answer = result.data.text?.trim() ?? "";
      messages.push({ role: "assistant", content: answer });
      return { answer, calls, costUsd, ...(model ? { model } : {}) };
    }
    messages.push({ role: "assistant", content: result.data.text ?? "", toolCalls });
    const results = await Promise.all(toolCalls.map((c) => runTool(data, ok, c.name, c.arguments)));
    toolCalls.forEach((c, i) => {
      const r = results[i]!;
      calls.push(r.call);
      options.onCall?.(r.call);
      const msg: AiMessage = { role: "tool", content: forModel(r.result), name: c.name };
      if (c.id) msg.toolCallId = c.id;
      messages.push(msg);
    });
  }
  return { error: "no answer" };
}
