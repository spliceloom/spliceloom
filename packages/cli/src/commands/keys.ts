/**
 * Publisher signing keys and signatures:
 *   splice keys generate [name]              create an Ed25519 key in SPLICE_HOME/keys (never overwrites)
 *   splice keys list [@namespace]            local keys, or the keys registered for a namespace
 *   splice keys register @namespace [--key]  register a local public key (namespace owner)
 *   splice keys revoke @namespace <keyId>    revoke a registered key (namespace owner)
 *   splice sign <@ns/name@version> [--key] [--dir]  sign a published version
 */
import { resolve } from "node:path";
import { generateSigningKey, listSigningKeys, loadSigningKey, packDirectory, signPublishedVersion } from "@spliceloom/core";
import { KEY_ID_PATTERN, isValidNameSegment, parsePackageRef, type SigningKeyInfo } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, registryFor } from "./shared.js";
import { requireToken } from "./tokens.js";

export interface KeyFlags {
  key?: string;
  dir?: string;
}

function json(ctx: Context, value: unknown): number {
  printJson(ctx, value);
  return 0;
}

function parseNamespace(value: string | undefined, usage: string): string {
  const ns = (value ?? "").replace(/^@/, "");
  if (!isValidNameSegment(ns)) throw new UsageError(`Invalid namespace "${value ?? ""}"`, usage);
  return ns;
}

function printRegistered(ctx: Context, keys: SigningKeyInfo[]): void {
  const s = ctx.style;
  if (keys.length === 0) {
    ctx.out("No signing keys registered.");
    return;
  }
  for (const k of keys) ctx.out(`${s.bold(k.keyId)}  ${k.revokedAt ? s.red(`revoked ${k.revokedAt.slice(0, 10)}`) : s.green("active")}  ${s.dim(`added by ${k.addedBy} ${k.addedAt.slice(0, 10)}`)}`);
}

export async function keysCommand(ctx: Context, positionals: string[], flags: KeyFlags): Promise<number> {
  const [action, arg, extra, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError("Too many arguments for keys");
  const s = ctx.style;
  switch (action) {
    case "generate": {
      if (extra !== undefined) throw new UsageError("Usage: splice keys generate [name]");
      const key = await generateSigningKey(arg ?? "default", ctx.io.env);
      if (ctx.json) return json(ctx, { name: key.name, keyId: key.keyId, publicKey: key.publicKey, path: key.path });
      ctx.out(`${s.green("Created")} signing key ${s.bold(key.name)} ${key.keyId}`);
      ctx.out(`  private key: ${key.path} ${s.dim("(stays on this machine — back it up, never share it)")}`);
      ctx.out(`  public key:  ${key.publicKey}`);
      ctx.out(s.dim(`Next: splice keys register @<namespace>${key.name === "default" ? "" : ` --key ${key.name}`}`));
      return 0;
    }
    case "list": {
      if (arg === undefined) {
        const keys = await listSigningKeys(ctx.io.env);
        if (ctx.json) return json(ctx, keys.map((k) => ({ name: k.name, keyId: k.keyId, publicKey: k.publicKey, path: k.path })));
        if (keys.length === 0) {
          ctx.out("No local signing keys. Create one with `splice keys generate`.");
          return 0;
        }
        for (const k of keys) ctx.out(`${s.bold(k.name.padEnd(12))} ${k.keyId}  ${s.dim(k.path)}`);
        return 0;
      }
      const ns = parseNamespace(arg, "Usage: splice keys list [@namespace]");
      const res = await (await registryFor(ctx)).listKeys(ns);
      if (ctx.json) return json(ctx, res);
      ctx.out(s.bold(`@${ns}`));
      printRegistered(ctx, res.keys);
      return 0;
    }
    case "register": {
      const ns = parseNamespace(arg, "Usage: splice keys register @<namespace> [--key name]");
      if (extra !== undefined) throw new UsageError("Usage: splice keys register @<namespace> [--key name]");
      const key = await loadSigningKey(flags.key ?? "default", ctx.io.env);
      const client = await registryFor(ctx);
      const info = await client.addKey(await requireToken(ctx, client), ns, key.publicKey);
      if (ctx.json) return json(ctx, info);
      ctx.out(`${s.green("Registered")} ${s.bold(info.keyId)} for @${ns}`);
      ctx.out(s.dim(`Sign published versions with: splice sign @${ns}/<name>@<version>${key.name === "default" ? "" : ` --key ${key.name}`}`));
      return 0;
    }
    case "revoke": {
      const ns = parseNamespace(arg, "Usage: splice keys revoke @<namespace> <keyId>");
      if (!extra || !KEY_ID_PATTERN.test(extra)) throw new UsageError("Usage: splice keys revoke @<namespace> <keyId>", "Key ids look like ed25519:0123456789abcdef (see `splice keys list @<namespace>`).");
      const client = await registryFor(ctx);
      const info = await client.revokeKey(await requireToken(ctx, client), ns, extra);
      if (ctx.json) return json(ctx, info);
      ctx.out(`${s.yellow("Revoked")} ${info.keyId} for @${ns}. Clients no longer trust signatures made with it.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown keys action "${action ?? ""}"`, "Use: splice keys generate | list | register | revoke");
  }
}

export async function signCommand(ctx: Context, positionals: string[], flags: KeyFlags): Promise<number> {
  const [refInput, ...extra] = positionals;
  if (!refInput || extra.length > 0) throw new UsageError("Usage: splice sign <@namespace/name@version> [--key name] [--dir path]");
  const ref = parsePackageRef(refInput);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref.range)) throw new UsageError("sign needs an exact version", `Example: splice sign ${ref.id}@1.0.0`);
  const client = await registryFor(ctx);
  const token = await requireToken(ctx, client);
  const options: Parameters<typeof signPublishedVersion>[4] = { key: flags.key ?? "default", env: ctx.io.env };
  if (flags.dir !== undefined) {
    const packed = await packDirectory(resolve(ctx.io.cwd, flags.dir));
    if (`@${packed.manifest.namespace}/${packed.manifest.name}` !== ref.id || packed.manifest.version !== ref.range) {
      throw new UsageError(`--dir contains @${packed.manifest.namespace}/${packed.manifest.name}@${packed.manifest.version}, not ${ref.id}@${ref.range}`);
    }
    options.expectedIntegrity = packed.integrity;
  } else if (!ctx.json) {
    ctx.err(ctx.style.dim("No --dir: downloading and verifying the published artifact before signing it."));
  }
  const signature = await signPublishedVersion(client, token, ref.id, ref.range, options);
  if (ctx.json) return json(ctx, { name: ref.id, version: ref.range, ...signature });
  ctx.out(`${ctx.style.green("Signed")} ${ctx.style.bold(`${ref.id}@${ref.range}`)} with ${signature.keyId}`);
  return 0;
}
