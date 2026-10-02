import { resolve } from "node:path";
import { UsageError, type Context } from "../io.js";
import { printJson, spliceFor } from "./shared.js";

export async function publishCommand(ctx: Context, positionals: string[], dryRun: boolean): Promise<number> {
  if (positionals.length > 1) throw new UsageError("publish accepts at most one directory");
  const dir = resolve(ctx.io.cwd, positionals[0] ?? ".");
  const splice = spliceFor(ctx);
  const client = await splice.registry();
  const s = ctx.style;

  const result = await splice.publish(dir, {
    dryRun,
    onStep: (step, detail) => {
      if (ctx.json) return;
      if (step === "validating") ctx.err(s.dim(`Validating ${detail}...`));
      if (step === "packaging") ctx.err(s.dim(`Packaging ${detail}...`));
      if (step === "publishing") ctx.err(s.dim(`Uploading and registering at ${detail}...`));
    },
  });

  if (ctx.json) {
    printJson(ctx, {
      name: result.id,
      version: result.version,
      integrity: result.integrity,
      size: result.size,
      files: result.files,
      dryRun: result.dryRun,
      registry: result.dryRun ? null : client.baseUrl,
    });
    return 0;
  }
  const summary = `${result.files} files, ${result.size} bytes, ${result.integrity}`;
  if (result.dryRun) {
    ctx.out(`Dry run: ${s.bold(`${result.id}@${result.version}`)} is valid (${summary})`);
    return 0;
  }
  ctx.out(`${s.green("Published")} ${s.bold(`${result.id}@${result.version}`)} to ${client.baseUrl}`);
  ctx.out(s.dim(`  ${summary}`));
  return 0;
}
