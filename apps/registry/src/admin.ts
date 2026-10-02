#!/usr/bin/env node
/**
 * Registry admin tool. Talks to the admin HTTP API of any Splice registry (local Node, local
 * Worker or production) using SPLICE_ADMIN_TOKEN. Tokens are read from the environment so they
 * never appear in shell history.
 *
 *   node apps/registry/dist/admin.js new-admin-token
 *   node apps/registry/dist/admin.js create-user <name>
 *   node apps/registry/dist/admin.js create-token <user> [label]
 *   node apps/registry/dist/admin.js revoke-token <token-id>
 *   node apps/registry/dist/admin.js set-owner <namespace> <user|--none>
 *
 * Registry: --registry <url|alias> or SPLICE_REGISTRY (default: local = http://127.0.0.1:8787).
 */
import { join, resolve } from "node:path";
import { expandRegistry } from "@spliceloom/core";
import { generateToken, hashToken } from "./auth.js";

const USAGE = `Usage: admin <command> [args] [--registry <url>]

Commands:
  new-admin-token                  Generate an admin token and its SHA-256 (for ADMIN_TOKEN_SHA256)
  create-user <name>               Create a registry user
  create-token <user> [label]      Create an API token for a user (printed once)
  revoke-token <token-id>          Revoke a token
  set-owner <namespace> <user>     Assign a namespace owner (--none to clear)
  migrate-artifacts                Copy artifacts from the legacy store (KV/R2) to GitHub Releases

Environment: SPLICE_ADMIN_TOKEN (required for API commands), SPLICE_REGISTRY.`;

export async function runAdmin(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void): Promise<number> {
  const args = [...argv];
  let registryInput = env.SPLICE_REGISTRY ?? "local";
  const flag = args.indexOf("--registry");
  if (flag !== -1) {
    registryInput = args[flag + 1] ?? "";
    args.splice(flag, 2);
  }
  const [command, ...rest] = args;
  let registry: string;
  try {
    registry = expandRegistry(registryInput);
  } catch (error) {
    out(`error: ${(error as Error).message}`);
    return 2;
  }

  if (command === "new-admin-token") {
    // Reuses the user token generator for 256 bits of randomness; the prefix is harmless.
    const token = generateToken().replace(/^splice_/, "splice_admin_");
    out(`admin token (store it securely, it is not saved anywhere): ${token}`);
    out(`ADMIN_TOKEN_SHA256=${await hashToken(token)}`);
    return 0;
  }

  const adminToken = env.SPLICE_ADMIN_TOKEN;
  const call = async (method: string, path: string, body?: unknown) => {
    if (!adminToken) throw new Error("SPLICE_ADMIN_TOKEN is not set");
    const init: RequestInit = { method, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${registry}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  try {
    switch (command) {
      case "create-user": {
        if (!rest[0]) break;
        const user = await call("POST", "/admin/users", { name: rest[0] });
        out(`created user ${String(user.name)}`);
        return 0;
      }
      case "create-token": {
        if (!rest[0]) break;
        const token = await call("POST", `/admin/users/${encodeURIComponent(rest[0])}/tokens`, { label: rest[1] ?? "default" });
        out(`token id: ${String(token.id)}`);
        out(`token (shown once): ${String(token.token)}`);
        return 0;
      }
      case "revoke-token": {
        if (!rest[0]) break;
        await call("POST", `/admin/tokens/${encodeURIComponent(rest[0])}/revoke`);
        out(`revoked ${rest[0]}`);
        return 0;
      }
      case "migrate-artifacts": {
        const result = await call("POST", "/admin/artifacts/migrate");
        const migrated = result.migrated as string[];
        const skipped = result.skipped as string[];
        out(`migrated: ${migrated.length > 0 ? migrated.join(", ") : "none"}`);
        if (skipped.length > 0) out(`skipped (missing or failed verification): ${skipped.join(", ")}`);
        return skipped.length > 0 ? 1 : 0;
      }
      case "set-owner": {
        if (!rest[0] || !rest[1]) break;
        const owner = rest[1] === "--none" ? null : rest[1];
        const result = await call("PUT", `/admin/namespaces/${encodeURIComponent(rest[0])}`, { owner });
        out(`@${String(result.namespace)} owner: ${String(result.owner ?? "none")}`);
        return 0;
      }
    }
  } catch (error) {
    out(`error: ${(error as Error).message}`);
    return 1;
  }
  out(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith(join("dist", "admin.js"));
if (invokedDirectly) {
  process.exitCode = await runAdmin(process.argv.slice(2), process.env, (s) => console.log(s));
}
