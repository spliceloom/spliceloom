/**
 * Minimal agent integration example for the Splice SDK.
 *
 * A (deliberately rule-based) agent receives a task, installs the capability it needs, discovers
 * the available tools from their real schemas, picks one, executes it in the Splice sandbox and
 * returns a structured result. Swap the `plan()` function for an LLM call in a real agent: the SDK
 * part stays the same.
 *
 *   node examples/agent/agent.ts "count the words in: Splice composes capabilities"
 *   SPLICE_REGISTRY=local node examples/agent/agent.ts "greet Dim"
 *
 * Options (env): SPLICE_REGISTRY (URL or alias), SPLICE_AGENT_DIR (project dir, default: a temp dir).
 * Prints one JSON object; exits 1 when the task fails.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Splice, type ToolDescriptor } from "@spliceloom/sdk";

interface Plan {
  tool: ToolDescriptor;
  input: Record<string, unknown>;
}

/** Chooses a tool and builds its input from the task, using only the tools' own schemas. */
function plan(task: string, tools: ToolDescriptor[]): Plan | null {
  const props = (t: ToolDescriptor) => Object.keys(t.inputSchema.properties ?? {});
  const greet = /^(?:greet|say hello to)\s+(.+)$/i.exec(task.trim());
  if (greet) {
    const tool = tools.find((t) => props(t).includes("name") && /greet/i.test(t.description));
    if (tool) return { tool, input: { name: greet[1]!.trim() } };
  }
  const text = /:\s*([\s\S]+)$/.exec(task)?.[1];
  if (text) {
    const tool = tools.find((t) => props(t).includes("text"));
    if (tool) return { tool, input: { text } };
  }
  return null;
}

async function main(): Promise<number> {
  const task = process.argv.slice(2).join(" ") || "count the words in: Splice composes capabilities for agents";
  const options: ConstructorParameters<typeof Splice>[0] = { project: process.env.SPLICE_AGENT_DIR ?? mkdtempSync(join(tmpdir(), "splice-agent-")) };
  if (process.env.SPLICE_REGISTRY) options.registry = process.env.SPLICE_REGISTRY;
  const splice = new Splice(options);

  // 1. Ensure the capability is installed (downloads, verifies SHA-256, validates; runs no code).
  await splice.init();
  const installed = await splice.add("@splice/example");

  // 2. Discover tools from the installed packages' manifests.
  const tools = await splice.tools();

  // 3. Decide what to do.
  const chosen = plan(task, tools);
  if (!chosen) {
    console.log(JSON.stringify({ ok: false, task, error: "No installed tool can handle this task", tools: tools.map((t) => t.name) }, null, 2));
    return 1;
  }

  // 4. Execute in the sandbox and return a structured result.
  const skill = await splice.load(chosen.tool.package);
  const result = await skill.run(chosen.tool.tool, chosen.input);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        task,
        registry: await splice.registryUrl(),
        package: `${installed.id}@${installed.version}`,
        integrity: installed.integrity,
        discovered: tools.map((t) => t.name),
        tool: chosen.tool.qualifiedName,
        input: chosen.input,
        ...(result.ok ? { output: result.output } : { error: result.error }),
      },
      null,
      2,
    ),
  );
  return result.ok ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.log(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  },
);
