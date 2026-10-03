# Framework adapters

`@spliceloom/adapters` gives the agent framework you already use Splice's tools: the read-only
live-data tools (Robinhood Chain tokens, stock tokens, perps, DeFi, oracle prices, wallets, global
markets) and the tools of your project's installed skills.

```sh
npm install @spliceloom/adapters      # Node.js 22.18+
```

The package has no dependency on any framework. You pass the framework's own `tool` factory, so
the framework stays your dependency, at your version.

| Framework | Function | You pass |
| --- | --- | --- |
| OpenAI Chat Completions (and compatible APIs) | `openAITools`, `runOpenAIToolCalls` | nothing |
| OpenAI Responses API | `openAIResponsesTools` | nothing |
| OpenAI Agents SDK | `openAIAgentsTools` | `tool` from `@openai/agents` |
| LangChain / LangGraph | `langChainTools` | `tool` from `@langchain/core/tools` |
| Vercel AI SDK | `aiSdkTools` | `{ tool, jsonSchema }` from `ai` |

## Collect the tools

```ts
import { spliceTools } from "@spliceloom/adapters";

const tools = await spliceTools({
  project: "./agent",              // installed skills come from this Splice project
  include: ["tokens_rank", "stock_quote", "defi_overview"], // optional allowlist
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `data` | `true` | Include the live-data tools (the same ones `splice mcp --data` serves). |
| `skills` | `true` | Installed skills: `true` (all), `false`, or package refs like `["@splice/github"]`. |
| `include` / `exclude` | — | Tool names to keep or drop. `ai_generate` and `ai_models` are never exposed. |
| `splice` / `project` | working directory | An existing `Splice` SDK client, or the project directory for a new one. |

Each tool is a plain object: `name`, `description`, `parameters` (JSON Schema) and
`execute(args)`. Names are valid for every framework (`[a-zA-Z0-9_-]`, at most 64 characters).
`execute` never throws; a failure comes back as `{ status: "ERROR", message }` for the model to read.

## OpenAI Chat Completions

Works with OpenAI and any compatible endpoint (OpenRouter, local servers).

```ts
import { openAITools, runOpenAIToolCalls, spliceTools } from "@spliceloom/adapters";
import OpenAI from "openai";

const client = new OpenAI();
const tools = await spliceTools({ skills: false });
const messages: any[] = [{ role: "user", content: "What is the TVL of Robinhood Chain?" }];

for (;;) {
  const { choices } = await client.chat.completions.create({ model: "gpt-4o-mini", messages, tools: openAITools(tools) });
  const message = choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) break;
  messages.push(...(await runOpenAIToolCalls(tools, message.tool_calls)));
}
```

A runnable version without the OpenAI package is in
[examples/adapters/openai-chat.ts](../examples/adapters/openai-chat.ts).

## OpenAI Agents SDK

```ts
import { Agent, run, tool } from "@openai/agents";
import { openAIAgentsTools, spliceTools } from "@spliceloom/adapters";

const agent = new Agent({
  name: "Research",
  instructions: "Answer from the tools and name the source of every number.",
  tools: openAIAgentsTools(await spliceTools(), tool),
});
console.log((await run(agent, "Top Robinhood stock tokens today?")).finalOutput);
```

## LangChain

```ts
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { langChainTools, spliceTools } from "@spliceloom/adapters";

const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools: langChainTools(await spliceTools(), tool) });
```

## Vercel AI SDK

```ts
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { aiSdkTools, spliceTools } from "@spliceloom/adapters";

const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  tools: aiSdkTools(await spliceTools(), { tool, jsonSchema }),
  stopWhen: stepCountIs(5),
  prompt: "Which perpetual markets on Robinhood Chain have the most open interest?",
});
```

## What stays the same

- **Skills run in the Splice sandbox**, limited to the permissions they declared, exactly as with
  `splice run`. Install them first with `splice add <package>`.
- **Data tools validate their input** against the schema before any provider is contacted.
- **Provider keys stay in your process.** They are read from the provider environment
  (`.env.local`, `~/.splice/.env`) and redacted from every result; the model only sees data.
- **Every data result keeps its status and provenance** (`LIVE`, `CACHED`, `UNAVAILABLE`,
  `ERROR`, source, fetch time). Results passed back to the model are trimmed to about 9,000
  characters; `execute()` returns the full result.
