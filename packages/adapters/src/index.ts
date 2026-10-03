/**
 * Splice tools for agent frameworks: OpenAI (Chat Completions and Responses), the OpenAI Agents SDK,
 * LangChain and the Vercel AI SDK — with zero runtime dependencies on those frameworks.
 *
 * `spliceTools()` collects Splice's read-only live-data tools and the tools of the project's installed
 * skills as plain objects (name, description, JSON Schema, execute). The adapters below turn them into
 * each framework's tool type; framework factories (`tool`, `jsonSchema`) are passed in by the caller,
 * so the frameworks stay the caller's own dependencies and versions.
 *
 * Skills still run in the Splice sandbox with their declared permissions; data tools validate input
 * against their schema before any provider is contacted, and provider keys never reach the model.
 */
import type { SpliceData } from "@spliceloom/data";
import { AGENT_EXCLUDED, forModel } from "@spliceloom/mcp/agent";
import { DATA_TOOLS } from "@spliceloom/mcp/data-tools";
import { Splice } from "@spliceloom/sdk";
import { redactSecrets, validateValue, type JsonSchema, type ToolDescriptor } from "@spliceloom/spec";

export interface SpliceTool {
  /** Tool name, valid for every framework (`[a-zA-Z0-9_-]`, ≤ 64 characters). */
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  parameters: JsonSchema;
  source: "data" | "skill";
  /** Runs the tool. Never throws: failures come back as `{ status: "ERROR", message }`. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** The parts of the SDK client the adapters use (a `Splice` instance satisfies it). */
export interface SpliceLike {
  readonly data: SpliceData;
  tools(ref?: string): Promise<ToolDescriptor[]>;
  run(toolRef: string, input?: unknown): Promise<{ ok: boolean; output?: unknown; error?: { code?: string; message?: string } }>;
}

export interface SpliceToolsOptions {
  /** SDK client (default: `new Splice({ project })`). */
  splice?: SpliceLike;
  /** Project directory for the default client (default: the working directory). */
  project?: string;
  /** Include the live-data tools (default true). */
  data?: boolean;
  /** Include installed skills: true (all, default), false, or package refs (`@splice/github`). */
  skills?: boolean | string[];
  /** Only these tool names. */
  include?: string[];
  /** Never these tool names (the AI tools `ai_generate` / `ai_models` are always excluded). */
  exclude?: string[];
}

const errorResult = (message: string) => ({ status: "ERROR", message });

export async function spliceTools(options: SpliceToolsOptions = {}): Promise<SpliceTool[]> {
  const splice: SpliceLike = options.splice ?? new Splice(options.project ? { project: options.project } : {});
  const exclude = new Set([...AGENT_EXCLUDED, ...(options.exclude ?? [])]);
  const include = options.include ? new Set(options.include) : undefined;
  const keep = (name: string) => !exclude.has(name) && (!include || include.has(name));
  const tools: SpliceTool[] = [];

  if (options.data !== false) {
    for (const t of DATA_TOOLS) {
      if (!keep(t.name)) continue;
      tools.push({
        name: t.name,
        description: t.description,
        parameters: t.input,
        source: "data",
        execute: async (args) => {
          const errors = validateValue(t.input, args ?? {}, "input");
          if (errors.length) return errorResult(errors.join("; "));
          try {
            return await t.run(splice.data, args ?? {});
          } catch (error) {
            return errorResult(redactSecrets(String((error as Error)?.message ?? error), splice.data.env.secrets));
          }
        },
      });
    }
  }

  if (options.skills !== false) {
    const descriptors = Array.isArray(options.skills) ? (await Promise.all(options.skills.map((ref) => splice.tools(ref)))).flat() : await splice.tools();
    for (const d of descriptors) {
      if (!keep(d.mcpName) && !keep(d.name)) continue;
      tools.push({
        name: d.mcpName,
        description: `${d.description} (Splice skill ${d.qualifiedName}, sandboxed)`,
        parameters: d.inputSchema,
        source: "skill",
        execute: async (args) => {
          try {
            const r = await splice.run(d.name, args ?? {});
            return r.ok ? r.output : errorResult(`${r.error?.code ?? "TOOL_FAILED"}: ${r.error?.message ?? "the tool failed"}`);
          } catch (error) {
            return errorResult(String((error as Error)?.message ?? error));
          }
        },
      });
    }
  }
  return tools;
}

/** A tool result as model-ready text (long lists and bulky fields trimmed, ≤ 9,000 characters). */
export function toolResultText(result: unknown): string {
  return typeof result === "string" ? result : forModel(result);
}

const find = (tools: SpliceTool[], name: string) => tools.find((t) => t.name === name);

// ------------------------------------------------------------------------------------------ OpenAI

/** Chat Completions `tools` array. */
export function openAITools(tools: SpliceTool[]): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }> {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Responses API `tools` array. */
export function openAIResponsesTools(tools: SpliceTool[]): Array<{ type: "function"; name: string; description: string; parameters: JsonSchema; strict: false }> {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

/** Runs Chat Completions `tool_calls` and returns the `tool` messages to append. */
export async function runOpenAIToolCalls(
  tools: SpliceTool[],
  toolCalls: ReadonlyArray<{ id: string; function: { name: string; arguments: string } }>,
): Promise<Array<{ role: "tool"; tool_call_id: string; content: string }>> {
  return Promise.all(
    toolCalls.map(async (call) => {
      const tool = find(tools, call.function.name);
      let result: unknown;
      if (!tool) result = errorResult(`no tool named ${call.function.name}`);
      else {
        try {
          result = await tool.execute(call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {});
        } catch {
          result = errorResult("arguments were not valid JSON");
        }
      }
      return { role: "tool" as const, tool_call_id: call.id, content: toolResultText(result) };
    }),
  );
}

/** Tools for the OpenAI Agents SDK: pass its `tool` function (`import { tool } from "@openai/agents"`). */
export function openAIAgentsTools<T>(tools: SpliceTool[], tool: (definition: { name: string; description: string; parameters: any; strict: false; execute: (input: any) => Promise<string> }) => T): T[] {
  return tools.map((t) => tool({ name: t.name, description: t.description, parameters: t.parameters, strict: false, execute: async (input) => toolResultText(await t.execute(input ?? {})) }));
}

// --------------------------------------------------------------------------------------- LangChain

/** LangChain tools: pass `tool` from `@langchain/core/tools` (JSON Schema input, string output). */
export function langChainTools<T>(tools: SpliceTool[], tool: (fn: (input: any) => Promise<string>, fields: { name: string; description: string; schema: any }) => T): T[] {
  return tools.map((t) => tool(async (input) => toolResultText(await t.execute(input ?? {})), { name: t.name, description: t.description, schema: t.parameters }));
}

// ------------------------------------------------------------------------------------ Vercel AI SDK

/** AI SDK tools: pass `{ tool, jsonSchema }` from `ai`. Returns the record `generateText` expects. */
export function aiSdkTools<T>(tools: SpliceTool[], ai: { tool: (definition: any) => T; jsonSchema: (schema: any) => unknown }): Record<string, T> {
  return Object.fromEntries(
    tools.map((t) => {
      const schema = ai.jsonSchema(t.parameters);
      // `inputSchema` (AI SDK 5) and `parameters` (AI SDK 4) carry the same schema.
      return [t.name, ai.tool({ description: t.description, inputSchema: schema, parameters: schema, execute: async (input: Record<string, unknown>) => t.execute(input ?? {}) })];
    }),
  );
}
