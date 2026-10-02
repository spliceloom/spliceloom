import { resolve } from "node:path";
import { CONFIG_FILE, SpliceProject } from "@spliceloom/core";
import { UsageError, type Context } from "../io.js";

export async function initCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length > 1) throw new UsageError("init accepts at most one directory");
  const dir = resolve(ctx.io.cwd, positionals[0] ?? ".");
  const options: { registry?: string } = {};
  if (ctx.registry) options.registry = ctx.registry;
  const { project, created } = await SpliceProject.init(dir, options);
  if (created) {
    ctx.out(`${ctx.style.green("Initialized")} Splice project in ${project.root}`);
    ctx.out(ctx.style.dim(`Next: splice search <query>, then splice add <package>`));
  } else {
    ctx.out(`Already a Splice project: ${project.root} (${CONFIG_FILE} exists)`);
  }
  return 0;
}
