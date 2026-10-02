import { parseToolRef, type JsonSchema } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, spliceFor } from "./shared.js";

/** Coerces a CLI string value using the property schema; falls back to JSON parsing for untyped properties. */
export function coerceValue(raw: string, schema: JsonSchema | undefined): unknown {
  const type = schema?.type;
  if (type === "string") return raw;
  if (type === "number" || type === "integer") {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function buildInput(pairs: string[], inputJson: string | undefined, schema: JsonSchema): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  if (inputJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch (error) {
      throw new UsageError(`--input is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError("--input must be a JSON object");
    }
    input = parsed as Record<string, unknown>;
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`Invalid argument "${pair}". Expected key=value.`);
    const key = pair.slice(0, eq);
    input[key] = coerceValue(pair.slice(eq + 1), schema.properties?.[key]);
  }
  return input;
}

export async function runCommand(ctx: Context, positionals: string[], inputJson?: string): Promise<number> {
  const [ref, ...pairs] = positionals;
  if (!ref) throw new UsageError("run requires a tool reference", "Example: splice run example.hello name=Dim");
  parseToolRef(ref);
  const target = parseToolRef(ref);
  const skill = await spliceFor(ctx).load(target.namespace ? `@${target.namespace}/${target.name}` : target.name);
  const tool = target.tool;
  const input = buildInput(pairs, inputJson, skill.tool(tool)?.inputSchema ?? { type: "object" });
  const result = await skill.run(tool, input);
  const pkg = skill.pkg;

  if (ctx.json) {
    printJson(ctx, result);
    return result.ok ? 0 : 1;
  }
  if (result.logs) {
    for (const line of result.logs.split(/\r?\n/)) ctx.err(ctx.style.dim(`[${pkg.id}.${tool}] ${line}`));
  }
  if (result.ok) {
    ctx.out(JSON.stringify(result.output, null, 2));
    return 0;
  }
  ctx.err(`${ctx.style.red("error:")} ${result.error.message} ${ctx.style.dim(`(${result.error.code})`)}`);
  for (const detail of result.error.details ?? []) ctx.err(`  - ${detail}`);
  return 1;
}
