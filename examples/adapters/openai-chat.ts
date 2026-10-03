/**
 * Splice tools with any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, …), no framework.
 *
 *   OPENAI_API_KEY=… node examples/adapters/openai-chat.ts "What is the TVL of Robinhood Chain?"
 *   (or OPENROUTER_API_KEY=… with OPENAI_BASE_URL=https://openrouter.ai/api/v1 and MODEL=openai/gpt-4o-mini)
 */
import { openAITools, runOpenAIToolCalls, spliceTools } from "@spliceloom/adapters";

const question = process.argv.slice(2).join(" ") || "What is the total value locked on Robinhood Chain right now?";
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
const model = process.env.MODEL ?? "gpt-4o-mini";
if (!apiKey) throw new Error("Set OPENAI_API_KEY (or OPENROUTER_API_KEY with OPENAI_BASE_URL).");

// Live-data tools only for this example; installed skills are added when skills: true.
const tools = await spliceTools({ skills: false, include: ["defi_overview", "tokens_rank", "stock_quote", "perps_markets"] });
const messages: any[] = [
  { role: "system", content: "Answer from the tools only and name the source of every number." },
  { role: "user", content: question },
];

for (let step = 0; step < 5; step++) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools: openAITools(tools) }),
  });
  if (!response.ok) throw new Error(`model API: HTTP ${response.status}`);
  const message = ((await response.json()) as { choices: Array<{ message: any }> }).choices[0]!.message;
  messages.push(message);
  if (!message.tool_calls?.length) {
    console.log(message.content);
    break;
  }
  for (const call of message.tool_calls) console.error(`→ ${call.function.name} ${call.function.arguments}`);
  messages.push(...(await runOpenAIToolCalls(tools, message.tool_calls)));
}
