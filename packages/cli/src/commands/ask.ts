/**
 * `splice ask "<question>"` and `splice chat`: a research agent over Splice's live data.
 *
 * The configured model (OpenRouter by default) gets Splice's read-only data tools — market, onchain,
 * wallet, security, stocks, oracle prices, web and GitHub — decides which to call, and answers from
 * the results. Every number in an answer comes from a tool result with its provider; the model is
 * told never to answer market or chain facts from memory. Tool calls are shown as they happen, and
 * the provider-reported cost of every model call is summed. The agent loop itself lives in
 * @spliceloom/mcp (shared with the hosted Ask endpoint).
 */
import { createInterface } from "node:readline";
import type { AiMessage, SpliceData } from "@spliceloom/data";
import { agentSystemPrompt, runAgentTurn, type AgentOptions, type AgentTurn } from "@spliceloom/mcp";
import { UsageError, type Context } from "../io.js";
import { dataFor, statusLine } from "./data.js";
import { renderMarkdown } from "../format.js";

export { agentTools, forModel } from "@spliceloom/mcp";

export interface AskFlags {
  model?: string;
  provider?: string;
  maxTokens?: string;
}

const systemPrompt = () => agentSystemPrompt();

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== "fresh")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/** One question → tool calls → answer. `messages` carries the conversation (chat mode). */
async function turn(ctx: Context, data: SpliceData, messages: AiMessage[], flags: AskFlags, progress: boolean): Promise<AgentTurn | { error: string }> {
  const maxTokens = flags.maxTokens !== undefined ? Number(flags.maxTokens) : 1_500;
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 16_000) throw new UsageError("--max-tokens must be an integer between 64 and 16000");
  const options: AgentOptions = { maxTokens };
  if (flags.model) options.model = flags.model;
  if (flags.provider) options.provider = flags.provider;
  if (progress) {
    options.onCall = (c) => {
      const mark = c.status === "LIVE" || c.status === "CACHED" ? ctx.style.green("✓") : ctx.style.yellow("–");
      ctx.err(ctx.style.dim(`  ${mark} ${c.name}  ${describeArgs(c.args)}  → ${c.status}${c.source ? ` ${c.source}` : ""}`));
    };
  }
  const t = await runAgentTurn(data, messages, options);
  if ("failure" in t) return { error: statusLine(ctx, t.failure) };
  return t;
}

function printTurn(ctx: Context, t: AgentTurn): void {
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
