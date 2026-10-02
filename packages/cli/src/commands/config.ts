import { REGISTRY_ALIASES, expandRegistry, readUserConfig, spliceHome, writeUserConfig } from "@spliceloom/core";
import { UsageError, type Context } from "../io.js";
import { printJson, resolveContextRegistry } from "./shared.js";

const KEYS = ["registry"];

export async function configCommand(ctx: Context, positionals: string[]): Promise<number> {
  const [action, key, value, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError("Too many arguments for config");
  if (key !== undefined && !KEYS.includes(key)) throw new UsageError(`Unknown config key "${key}". Known keys: ${KEYS.join(", ")}`);

  switch (action) {
    case "get": {
      if (key === undefined) throw new UsageError("Usage: splice config get registry");
      const { url, source } = await resolveContextRegistry(ctx);
      if (ctx.json) printJson(ctx, { registry: url, source });
      else ctx.out(`${url} ${ctx.style.dim(`(${source})`)}`);
      return 0;
    }
    case "set": {
      if (key === undefined || value === undefined) {
        throw new UsageError("Usage: splice config set registry <url|alias>", `Aliases: ${Object.keys(REGISTRY_ALIASES).join(", ")}`);
      }
      const url = expandRegistry(value);
      await writeUserConfig({ ...(await readUserConfig(ctx.io.env)), registry: url }, ctx.io.env);
      ctx.out(`registry = ${url}`);
      return 0;
    }
    case "unset": {
      if (key === undefined) throw new UsageError("Usage: splice config unset registry");
      const config = await readUserConfig(ctx.io.env);
      delete config.registry;
      await writeUserConfig(config, ctx.io.env);
      ctx.out("registry unset (using the default)");
      return 0;
    }
    case "list":
    case undefined: {
      const { url, source } = await resolveContextRegistry(ctx);
      const user = await readUserConfig(ctx.io.env);
      if (ctx.json) {
        printJson(ctx, { home: spliceHome(ctx.io.env), registry: url, source, userConfig: user, aliases: REGISTRY_ALIASES });
        return 0;
      }
      ctx.out(`home:      ${spliceHome(ctx.io.env)}`);
      ctx.out(`registry:  ${url} ${ctx.style.dim(`(${source})`)}`);
      ctx.out(`aliases:   ${Object.entries(REGISTRY_ALIASES).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown config action "${action}"`, "Use: splice config [list|get|set|unset] registry [value]");
  }
}
