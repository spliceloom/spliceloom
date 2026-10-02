import { isValidNameSegment, type NamespaceResponse } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, registryFor } from "./shared.js";
import { requireToken } from "./tokens.js";

function parseNamespace(value: string | undefined): string {
  const ns = (value ?? "").replace(/^@/, "");
  if (!isValidNameSegment(ns)) throw new UsageError(`Invalid namespace "${value ?? ""}"`, "Example: splice namespace info @dim");
  return ns;
}

function print(ctx: Context, info: NamespaceResponse): void {
  if (ctx.json) {
    printJson(ctx, info);
    return;
  }
  ctx.out(`${ctx.style.bold(`@${info.namespace}`)}${info.reserved ? ctx.style.dim(" (reserved)") : ""}`);
  ctx.out(`owner:        ${info.owner ?? "none"}`);
  ctx.out(`maintainers:  ${info.maintainers.length > 0 ? info.maintainers.join(", ") : "none"}`);
  ctx.out(`packages:     ${info.packages.length > 0 ? info.packages.join(", ") : "none"}`);
}

export async function namespaceCommand(ctx: Context, positionals: string[]): Promise<number> {
  const [action, nsArg, user, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError("Too many arguments for namespace");
  const client = await registryFor(ctx);

  switch (action) {
    case "info":
      if (user !== undefined) throw new UsageError("Usage: splice namespace info @<namespace>");
      print(ctx, await client.getNamespace(parseNamespace(nsArg)));
      return 0;
    case "add-maintainer":
    case "remove-maintainer": {
      const ns = parseNamespace(nsArg);
      if (!user || !isValidNameSegment(user)) throw new UsageError(`Usage: splice namespace ${action} @<namespace> <user>`);
      const token = await requireToken(ctx, client);
      const info = action === "add-maintainer" ? await client.addMaintainer(token, ns, user) : await client.removeMaintainer(token, ns, user);
      if (!ctx.json) ctx.err(ctx.style.green(action === "add-maintainer" ? `Added ${user} to @${ns}` : `Removed ${user} from @${ns}`));
      print(ctx, info);
      return 0;
    }
    default:
      throw new UsageError(`Unknown namespace action "${action ?? ""}"`, "Use: splice namespace info | add-maintainer | remove-maintainer");
  }
}
