/**
 * Agent packages end to end: a local registry serves a skill and an agent package, the CLI installs
 * both, and `splice agent run` lets a (faked) model call exactly the tools of the agent's skills.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { packDirectory } from "@spliceloom/core";
import type { RegistryService } from "@spliceloom/registry";
import { openLocalRegistry, serveRegistry, type RunningServer } from "@spliceloom/registry/node";
import { validateManifest } from "@spliceloom/spec";
import { main } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(here, "../../../skills/example");

const AGENT_MANIFEST = {
  specVersion: 1,
  namespace: "acme",
  name: "greeter",
  version: "0.1.0",
  description: "Agent that greets people with the example skill.",
  runtime: { type: "node" },
  permissions: { fs: { read: [], write: [] }, network: [], env: [] },
  tools: [],
  agent: { instructions: "Greet the person the user names. Always use the hello tool.", skills: ["@splice/example"], examples: ["Say hi to Dim"] },
};

describe("agent packages", () => {
  let root: string;
  let project: string;
  let service: RegistryService;
  let server: RunningServer;
  const modelRequests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];

  const splice = async (...argv: string[]) => {
    let stdout = "";
    let stderr = "";
    let aiCalls = 0;
    const code = await main(argv, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      cwd: project,
      env: { SPLICE_HOME: join(root, "home"), SPLICE_REGISTRY: server.url, OPENROUTER_API_KEY: "sk-or-test-key", ROBINHOOD_PUBLIC_RPC_URL: "off" },
      color: false,
      dataFetch: async (url: string, init?: RequestInit) => {
        if (!url.includes("openrouter.ai/api/v1/chat/completions")) return new Response("not mocked", { status: 500 });
        modelRequests.push(JSON.parse(String(init?.body)));
        aiCalls++;
        if (aiCalls === 1) {
          return Response.json({ id: "a", model: "openai/gpt-4o-mini", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "splice_example_hello", arguments: '{"name":"Dim"}' } }, { id: "call_2", type: "function", function: { name: "tokens_trending", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 } });
        }
        return Response.json({ id: "b", model: "openai/gpt-4o-mini", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done: I greeted Dim." } }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.00001 } });
      },
    });
    return { code, stdout, stderr };
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-agent-"));
    project = join(root, "project");
    mkdirSync(project);
    service = openLocalRegistry(join(root, "registry-data"));
    const splicePublisher = await service.createUser("splice");
    await service.setNamespaceOwner("splice", "splice");
    await service.publish((await packDirectory(EXAMPLE_DIR)).bytes, splicePublisher);
    const agentDir = join(root, "greeter");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "manifest.json"), JSON.stringify(AGENT_MANIFEST, null, 2));
    writeFileSync(join(agentDir, "SKILL.md"), "# @acme/greeter\n\nAn agent that greets people.\n");
    await service.publish((await packDirectory(agentDir)).bytes, await service.createUser("acme"));
    server = await serveRegistry({ service, port: 0 });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("validates the agent section of a manifest", () => {
    const ok = validateManifest(AGENT_MANIFEST);
    assert.ok(ok.ok);
    assert.deepEqual(ok.value.agent, AGENT_MANIFEST.agent);
    assert.deepEqual(ok.value.tools, []);
    const errorsOf = (agent: unknown, extra: Record<string, unknown> = {}) => {
      const r = validateManifest({ ...AGENT_MANIFEST, ...extra, agent });
      return r.ok ? [] : r.errors;
    };
    assert.match(errorsOf({ skills: [] }).join("; "), /agent\.instructions: is required/);
    assert.match(errorsOf({ instructions: "x", skills: ["example"] }).join("; "), /agent\.skills: invalid package name "example"/);
    assert.match(errorsOf({ instructions: "x", skills: ["@acme/greeter"] }).join("; "), /cannot list itself/);
    assert.match(errorsOf({ instructions: "x", skills: ["@a/b", "@a/b"] }).join("; "), /duplicate package/);
    assert.match(errorsOf({ instructions: "x".repeat(8001), skills: [] }).join("; "), /at most 8000 characters/);
    assert.match(errorsOf({ instructions: "x", skills: [], secret: 1 }).join("; "), /agent\.secret: unknown field/);
    assert.match(errorsOf({ instructions: "x", skills: [], examples: [""] }).join("; "), /agent\.examples/);
    // Only agent packages may have no tools.
    const { agent: _agent, ...skillOnly } = AGENT_MANIFEST;
    const noTools = validateManifest(skillOnly);
    assert.ok(!noTools.ok && noTools.errors.includes("tools: must be a non-empty array"));
  });

  it("lists agents separately in registry search", async () => {
    assert.deepEqual((await service.search("", 20, "agent")).results.map((r) => `${r.name}:${r.kind}`), ["@acme/greeter:agent"]);
    assert.deepEqual((await service.search("", 20, "skill")).results.map((r) => `${r.name}:${r.kind}`), ["@splice/example:skill"]);
    assert.equal((await service.search("", 20)).results.length, 2);
    const r = await fetch(`${server.url}/packages/search?q=&kind=agent`);
    assert.deepEqual(((await r.json()) as { results: Array<{ name: string }> }).results.map((x) => x.name), ["@acme/greeter"]);
    assert.equal((await fetch(`${server.url}/packages/search?q=&kind=other`)).status, 400);
    assert.deepEqual((await service.getVersion("@acme/greeter", "0.1.0")).manifest.agent, AGENT_MANIFEST.agent);
  });

  it("refuses to run until the agent's skills are installed, and names them", async () => {
    assert.equal((await splice("init")).code, 0);
    const add = await splice("add", "@acme/greeter");
    assert.equal(add.code, 0, add.stderr);
    const r = await splice("agent", "run", "@acme/greeter", "Say hi to Dim");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /needs skills that are not installed: @splice\/example/);
    assert.match(r.stderr, /splice add @splice\/example/);
    assert.equal(modelRequests.length, 0, "the model is not called");
  });

  it("gives the model only the tools of the agent's skills and runs them in the sandbox", async () => {
    const add = await splice("add", "@splice/example", "--accept-permissions");
    assert.equal(add.code, 0, add.stderr);
    const info = await splice("agent", "info", "@acme/greeter");
    assert.match(info.stdout, /@acme\/greeter v0\.1\.0 {2}agent/);
    assert.match(info.stdout, /tools it can call: .*@splice\/example\.hello/);

    const r = await splice("agent", "run", "@acme/greeter", "Say hi to Dim", "--json");
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { agent: string; answer: string; toolCalls: Array<{ name: string; status: string; args: unknown }> };
    assert.equal(out.agent, "@acme/greeter");
    assert.equal(out.answer, "Done: I greeted Dim.");
    // The skill's tool ran; a live-data tool the agent was never given is refused, not executed.
    assert.deepEqual(out.toolCalls.map((c) => `${c.name}:${c.status}`), ["@splice/example.hello:OK", "tokens_trending:ERROR"]);

    const [first, second] = modelRequests;
    assert.ok(first!.tools!.every((t) => t.function.name.startsWith("splice_example_")), "only the skill's tools are offered");
    assert.match(first!.messages[0]!.content, /You are the agent "@acme\/greeter"[\s\S]*Greet the person the user names/);
    const toolMessages = second!.messages.filter((m) => m.role === "tool");
    assert.match(toolMessages[0]!.content, /Dim/);
    assert.match(toolMessages[1]!.content, /UNKNOWN_TOOL/);
  });

  it("explains itself when the package is not an agent", async () => {
    const r = await splice("agent", "run", "@splice/example", "hello");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /@splice\/example is not an agent package/);
    assert.equal((await splice("agent", "start", "@acme/greeter")).code, 2);
  });
});
