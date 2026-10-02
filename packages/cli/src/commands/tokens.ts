import { CoreError, getToken, type RegistryClient } from "@spliceloom/core";
import { MAX_TOKEN_DAYS, type TokenInfo } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, registryFor } from "./shared.js";

export async function requireToken(ctx: Context, client: RegistryClient): Promise<string> {
  const credential = await getToken(client.baseUrl, ctx.io.env);
  if (!credential) throw new CoreError("NOT_LOGGED_IN", `Not logged in to ${client.baseUrl}.`, { hint: "Run `splice login`." });
  return credential.token;
}

/** "30", "30d" → 30 days. */
export function parseDays(value: string): number {
  const match = /^(\d+)d?$/.exec(value.trim());
  const days = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
    throw new UsageError(`--expires must be a number of days between 1 and ${MAX_TOKEN_DAYS} (e.g. 30d)`);
  }
  return days;
}

function describeScope(t: TokenInfo): string {
  const scope = t.namespaces ? t.namespaces.map((n) => `@${n}`).join(",") : "all namespaces";
  const kind = t.canManage ? "full" : "publish-only";
  return `${kind}, ${scope}, ${t.expiresAt ? `expires ${t.expiresAt.slice(0, 10)}` : "no expiry"}`;
}

export async function tokenCommand(
  ctx: Context,
  positionals: string[],
  flags: { label?: string; namespace?: string[]; expires?: string },
): Promise<number> {
  const [action, arg, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError("Too many arguments for token");
  const client = await registryFor(ctx);
  const s = ctx.style;

  switch (action) {
    case "list": {
      const { tokens } = await client.listTokens(await requireToken(ctx, client));
      if (ctx.json) {
        printJson(ctx, { tokens });
        return 0;
      }
      for (const t of tokens) {
        const state = t.revokedAt ? s.red("revoked") : t.expiresAt && t.expiresAt <= new Date().toISOString() ? s.yellow("expired") : s.green("active");
        ctx.out(`${t.id}  ${state}  ${s.bold(t.label)}${t.current ? s.cyan(" (this token)") : ""}`);
        ctx.out(s.dim(`    ${describeScope(t)}; last used ${t.lastUsedAt ?? "never"}`));
      }
      return 0;
    }
    case "create": {
      if (arg !== undefined) throw new UsageError("Usage: splice token create [--label <l>] [--namespace <ns>]... [--expires <days>]");
      const options: { label?: string; namespaces?: string[]; expiresInDays?: number } = {};
      if (flags.label) options.label = flags.label;
      if (flags.namespace?.length) options.namespaces = flags.namespace.map((n) => n.replace(/^@/, ""));
      if (flags.expires) options.expiresInDays = parseDays(flags.expires);
      const created = await client.createToken(await requireToken(ctx, client), options);
      if (ctx.json) {
        printJson(ctx, created);
        return 0;
      }
      ctx.err(`${s.green("Created")} token ${created.id} (${describeScope(created)})`);
      ctx.err(s.yellow("Copy it now: it is shown only once. Use it as SPLICE_TOKEN in CI."));
      ctx.out(created.token);
      return 0;
    }
    case "revoke": {
      if (!arg) throw new UsageError("Usage: splice token revoke <token-id>");
      await client.revokeToken(await requireToken(ctx, client), arg);
      ctx.out(`Revoked ${arg}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown token action "${action ?? ""}"`, "Use: splice token list | create | revoke <id>");
  }
}
