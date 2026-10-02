/**
 * Skill composition with the Splice SDK: the output of one skill becomes the input of the next.
 * No workflow engine, no framework — just tool calls with structured data in between.
 *
 * Default (deterministic, offline apart from the registry):
 *   @splice/files  write + read a fixture document in workspace/
 *        ↓ content (string)
 *   @splice/json   parse   → structured value
 *        ↓ value
 *   @splice/json   pick    → only the fields the "agent" needs
 *
 * Online (--url https://…): @splice/http get (raw text) → @splice/json parse → @splice/json pick
 *
 *   node examples/agent-composition/compose.ts
 *   node examples/agent-composition/compose.ts --url https://api.github.com/repos/spliceloom/splice-artifacts
 *
 * Env: SPLICE_REGISTRY (URL or alias), SPLICE_AGENT_DIR (project dir, default: a temp dir).
 * Installing @splice/files / @splice/http accepts their declared permissions (workspace/ only;
 * public hosts only) — review them with `splice info` first in a real agent.
 * Prints one JSON object with every step; exits 1 when a step fails.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Splice, type ToolResult } from "@spliceloom/sdk";

const FIXTURE = {
  full_name: "spliceloom/splice",
  description: "Composable capabilities for autonomous agents",
  stargazers_count: 42,
  license: { spdx_id: "MIT" },
  topics: ["agents", "mcp", "skills"],
  owner: { login: "spliceloom", type: "Organization" },
};
const FIELDS = ["full_name", "stargazers_count", "license.spdx_id", "topics[0]", "owner.login"];

interface Step {
  tool: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: unknown;
}

async function main(): Promise<number> {
  const urlFlag = process.argv.indexOf("--url");
  const url = urlFlag > 0 ? process.argv[urlFlag + 1] : undefined;
  const options: ConstructorParameters<typeof Splice>[0] = { project: process.env.SPLICE_AGENT_DIR ?? mkdtempSync(join(tmpdir(), "splice-compose-")) };
  if (process.env.SPLICE_REGISTRY) options.registry = process.env.SPLICE_REGISTRY;
  const splice = new Splice(options);
  await splice.init();

  const steps: Step[] = [];
  const run = async (tool: string, input: Record<string, unknown>): Promise<Record<string, any>> => {
    const result: ToolResult = await splice.run(tool, input);
    steps.push(result.ok ? { tool, input, ok: true, output: result.output } : { tool, input, ok: false, error: result.error });
    if (!result.ok) throw new Error(`${tool} failed: ${result.error.code}: ${result.error.message}`);
    return result.output as Record<string, any>;
  };

  await splice.add("@splice/json");
  let text: string;
  if (url) {
    await splice.add("@splice/http", { acceptPermissions: true });
    // Skill A: fetch raw text (JSON parsing is deliberately left to skill B).
    text = (await run("http.get", { url, responseType: "text", headers: { accept: "application/json" } })).text;
  } else {
    await splice.add("@splice/files", { acceptPermissions: true });
    await run("files.write", { path: "fixtures/repository.json", content: JSON.stringify(FIXTURE, null, 2), mode: "overwrite" });
    // Skill A: read the document back from the sandboxed workspace.
    text = (await run("files.read", { path: "fixtures/repository.json" })).content;
  }
  // Skill B: A's output (text) → structured value.
  const parsed = await run("json.parse", { text });
  // Skill B again: keep only what the agent needs.
  const picked = await run("json.pick", { value: parsed.value, paths: FIELDS });

  const result = Object.fromEntries((picked.results as Array<{ path: string; found: boolean; value?: unknown }>).map((r) => [r.path, r.found ? r.value : null]));
  console.log(JSON.stringify({ ok: true, source: url ?? "workspace/fixtures/repository.json", result, missing: picked.missing, steps: steps.map((s) => s.tool) }, null, 2));
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.log(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  },
);
