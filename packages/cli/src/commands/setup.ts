/**
 * `splice setup`: what works without keys, which provider variables unlock more, where to get
 * each key, and which ones are already set (names only — values are never printed).
 * `splice setup --template` prints a .env.local template (variable names and comments only).
 * `splice setup --init` writes that template to `<SPLICE_HOME>/.env` (never overwrites).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spliceHome } from "@spliceloom/core";
import { setupStatus, setupTemplate } from "@spliceloom/data";
import { UsageError, type Context } from "../io.js";
import { dataFor } from "./data.js";
import { printJson } from "./shared.js";

export async function setupCommand(ctx: Context, positionals: string[], flags: { template?: boolean; init?: boolean }): Promise<number> {
  if (positionals.length > 0) throw new UsageError("setup takes no arguments", "Usage: splice setup [--init | --template] [--json]");
  if (flags.template) {
    ctx.io.stdout(setupTemplate() + "\n");
    return 0;
  }
  if (flags.init) {
    const home = spliceHome(ctx.io.env);
    const file = join(home, ".env");
    const created = !existsSync(file);
    if (created) {
      mkdirSync(home, { recursive: true });
      writeFileSync(file, setupTemplate() + "\n", { mode: 0o600 });
    }
    if (ctx.json) printJson(ctx, { file, created });
    else {
      ctx.out(created ? `created ${file}` : `${file} already exists (left unchanged)`);
      ctx.out(ctx.style.dim("Open it, paste the keys you have after the = signs, save, then run `splice setup` again. Keys in this file work from every directory; a project's .env.local takes precedence."));
    }
    return 0;
  }
  const data = dataFor(ctx);
  const status = setupStatus(data.env.values);
  if (ctx.json) {
    printJson(ctx, { envFile: data.env.file, features: status });
    return 0;
  }
  const s = ctx.style;
  ctx.out(s.bold("Splice live data — what works now and how to unlock more"));
  ctx.out(s.dim(`Keys are read only from provider environment variables (process env, then ${data.env.file ?? ".env.local / .env in this or a parent directory, else ~/.splice/.env"}). Values are never shown.`));
  for (const f of status) {
    ctx.out("");
    ctx.out(s.bold(f.feature));
    ctx.out(`  ${f.withoutKeys ? `${s.green("works without keys:")} ${f.withoutKeys}` : s.yellow("needs a key")}`);
    for (const k of f.keys) {
      const mark = k.set ? s.green("✓ set") : s.dim("· not set");
      ctx.out(`  ${mark.padEnd(k.set ? 5 : 9)}  ${k.provider.padEnd(18)} ${k.env.join(k.together ? " + " : " or ").padEnd(36)} ${s.dim(k.url)}`);
      if (k.note) ctx.out(`  ${"".padEnd(9)}  ${s.dim(k.note)}`);
    }
    ctx.out(s.dim(`  try: ${f.commands[0]}`));
  }
  ctx.out("");
  ctx.out(s.dim("Next: `splice setup --init` creates ~/.splice/.env (used from every directory); fill in the keys you have, then `splice providers` to check them live."));
  return 0;
}
