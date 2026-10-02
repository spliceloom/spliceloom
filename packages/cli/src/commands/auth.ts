import { CoreError, getToken, removeCredential, saveCredential } from "@spliceloom/core";
import { UsageError, type Context } from "../io.js";
import { printJson, registryFor } from "./shared.js";

export async function loginCommand(ctx: Context, positionals: string[], tokenFlag?: string): Promise<number> {
  if (positionals.length > 0) throw new UsageError("login takes no arguments", "Usage: splice login [--token <token>] [--registry <url>]");
  const client = await registryFor(ctx);

  let token = tokenFlag;
  if (token === undefined) {
    if (!ctx.io.readSecret) throw new UsageError("No token provided", "Pass --token <token> or pipe it on stdin.");
    token = await ctx.io.readSecret(`Token for ${client.baseUrl}: `);
  } else {
    ctx.err(ctx.style.yellow("warning: --token may be saved in your shell history; prefer the interactive prompt or stdin."));
  }
  token = token.trim();
  if (!token || /\s/.test(token)) throw new UsageError("The token is empty or contains whitespace");

  const me = await client.whoami(token).catch((error: unknown) => {
    if (error instanceof CoreError && error.code === "UNAUTHENTICATED") {
      throw new CoreError("UNAUTHENTICATED", `The registry at ${client.baseUrl} rejected this token.`, {
        hint: "Check that the token is correct, not revoked, and meant for this registry.",
      });
    }
    throw error;
  });
  await saveCredential(client.baseUrl, token, me.user, ctx.io.env);
  if (ctx.io.env.SPLICE_TOKEN) ctx.err(ctx.style.yellow("note: SPLICE_TOKEN is set and takes precedence over the saved token."));
  ctx.out(`${ctx.style.green("Logged in")} to ${client.baseUrl} as ${ctx.style.bold(me.user)}`);
  return 0;
}

export async function logoutCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length > 0) throw new UsageError("logout takes no arguments");
  const client = await registryFor(ctx);
  const removed = await removeCredential(client.baseUrl, ctx.io.env);
  ctx.out(removed ? `Logged out of ${client.baseUrl}` : `Not logged in to ${client.baseUrl}`);
  return 0;
}

export async function whoamiCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length > 0) throw new UsageError("whoami takes no arguments");
  const client = await registryFor(ctx);
  const credential = await getToken(client.baseUrl, ctx.io.env);
  if (!credential) {
    throw new CoreError("NOT_LOGGED_IN", `Not logged in to ${client.baseUrl}.`, { hint: "Run `splice login`." });
  }
  const me = await client.whoami(credential.token);
  if (ctx.json) {
    printJson(ctx, { registry: client.baseUrl, ...me, tokenSource: credential.source });
    return 0;
  }
  const list = (names: string[]) => (names.length > 0 ? names.map((n) => `@${n}`).join(", ") : "none");
  ctx.out(`${ctx.style.bold(me.user)} on ${client.baseUrl}${credential.source === "env" ? " (SPLICE_TOKEN)" : ""}`);
  if (me.namespaces.length === 0) {
    ctx.out("namespaces: none yet (publishing claims an unowned namespace)");
  } else {
    ctx.out(`owns:       ${list(me.owns ?? me.namespaces)}`);
    ctx.out(`maintains:  ${list(me.maintains ?? [])}`);
  }
  if (me.token) {
    const scope = me.token.namespaces ? list(me.token.namespaces) : "all namespaces";
    ctx.out(ctx.style.dim(`token:      ${me.token.label} (${me.token.canManage ? "full" : "publish-only"}, ${scope}, ${me.token.expiresAt ? `expires ${me.token.expiresAt}` : "no expiry"})`));
  }
  return 0;
}
