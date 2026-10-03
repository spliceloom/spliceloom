import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpliceData } from "@spliceloom/data";
import type { ToolDescriptor } from "@spliceloom/spec";
import { aiSdkTools, langChainTools, openAIAgentsTools, openAIResponsesTools, openAITools, runOpenAIToolCalls, spliceTools, type SpliceLike } from "./index.js";

const descriptor = {
  package: "@splice/example",
  version: "0.1.0",
  tool: "hello",
  name: "example.hello",
  qualifiedName: "@splice/example.hello",
  mcpName: "splice_example_hello",
  description: "Says hello.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
} as unknown as ToolDescriptor;

function fakeSplice(): SpliceLike & { runs: Array<[string, unknown]> } {
  const runs: Array<[string, unknown]> = [];
  // Network access fails loudly: these tests must never reach a provider.
  const data = new SpliceData({ env: {}, envFile: null, fetch: async () => Promise.reject(new Error("no network in tests")) });
  return {
    runs,
    data,
    tools: async () => [descriptor],
    run: async (ref, input) => {
      runs.push([ref, input]);
      return (input as { name?: string }).name === "fail" ? { ok: false, error: { code: "TOOL_FAILED", message: "nope" } } : { ok: true, output: { greeting: `hello ${(input as { name: string }).name}` } };
    },
  };
}

describe("spliceTools", () => {
  it("collects data tools and installed skill tools with framework-safe names", async () => {
    const tools = await spliceTools({ splice: fakeSplice() });
    assert.ok(tools.some((t) => t.name === "tokens_rank" && t.source === "data"));
    assert.ok(tools.some((t) => t.name === "splice_example_hello" && t.source === "skill"));
    assert.ok(!tools.some((t) => t.name === "ai_generate" || t.name === "ai_models"), "AI tools are never exposed");
    for (const t of tools) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("filters with include / exclude / data / skills", async () => {
    const splice = fakeSplice();
    assert.deepEqual((await spliceTools({ splice, include: ["tokens_rank", "splice_example_hello"] })).map((t) => t.name), ["tokens_rank", "splice_example_hello"]);
    assert.ok((await spliceTools({ splice, data: false })).every((t) => t.source === "skill"));
    assert.ok((await spliceTools({ splice, skills: false })).every((t) => t.source === "data"));
    assert.ok(!(await spliceTools({ splice, exclude: ["tokens_rank"] })).some((t) => t.name === "tokens_rank"));
  });

  it("validates data tool input before any provider call and runs skills in the SDK", async () => {
    const splice = fakeSplice();
    const tools = await spliceTools({ splice });
    const rank = tools.find((t) => t.name === "tokens_rank")!;
    const bad = (await rank.execute({ unknownField: 1 })) as { status: string; message: string };
    assert.equal(bad.status, "ERROR");
    const hello = tools.find((t) => t.name === "splice_example_hello")!;
    assert.deepEqual(await hello.execute({ name: "Dim" }), { greeting: "hello Dim" });
    assert.deepEqual(splice.runs[0], ["example.hello", { name: "Dim" }]);
    assert.deepEqual(await hello.execute({ name: "fail" }), { status: "ERROR", message: "TOOL_FAILED: nope" });
  });
});

describe("framework adapters", () => {
  it("maps to OpenAI Chat Completions and Responses tool definitions and runs tool calls", async () => {
    const tools = await spliceTools({ splice: fakeSplice(), data: false });
    assert.deepEqual(openAITools(tools)[0], { type: "function", function: { name: "splice_example_hello", description: tools[0]!.description, parameters: descriptor.inputSchema } });
    assert.equal(openAIResponsesTools(tools)[0]!.strict, false);
    const messages = await runOpenAIToolCalls(tools, [
      { id: "call_1", function: { name: "splice_example_hello", arguments: '{"name":"Dim"}' } },
      { id: "call_2", function: { name: "missing", arguments: "{}" } },
      { id: "call_3", function: { name: "splice_example_hello", arguments: "{oops" } },
    ]);
    assert.deepEqual(messages[0], { role: "tool", tool_call_id: "call_1", content: '{"greeting":"hello Dim"}' });
    assert.match(messages[1]!.content, /no tool named missing/);
    assert.match(messages[2]!.content, /not valid JSON/);
  });

  it("builds OpenAI Agents, LangChain and AI SDK tools through the caller's factories", async () => {
    const tools = await spliceTools({ splice: fakeSplice(), data: false });
    const agents = openAIAgentsTools(tools, (d) => d);
    assert.equal(agents[0]!.name, "splice_example_hello");
    assert.equal(agents[0]!.strict, false);
    assert.equal(await agents[0]!.execute({ name: "A" }), '{"greeting":"hello A"}');

    const lc = langChainTools(tools, (fn, fields) => ({ fn, fields }));
    assert.equal(lc[0]!.fields.name, "splice_example_hello");
    assert.deepEqual(lc[0]!.fields.schema, descriptor.inputSchema);
    assert.equal(await lc[0]!.fn({ name: "B" }), '{"greeting":"hello B"}');

    const ai = aiSdkTools(tools, { tool: (d) => d, jsonSchema: (s) => ({ wrapped: s }) });
    assert.deepEqual(ai.splice_example_hello.inputSchema, { wrapped: descriptor.inputSchema });
    assert.deepEqual(await ai.splice_example_hello.execute({ name: "C" }), { greeting: "hello C" });
  });
});
