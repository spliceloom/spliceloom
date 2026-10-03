/**
 * Local Ed25519 signing keys for publishers: generated and stored in `SPLICE_HOME/keys/<name>.key`
 * (PKCS#8 PEM, readable by the owner only where the OS supports it). Private keys never leave this
 * machine; only the public key is registered with the registry.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyIdOf, signaturePayload, verifyArtifact, type PackageSignature } from "@spliceloom/spec";
import { CoreError } from "./errors.js";
import type { RegistryClient } from "./registry-client.js";
import { spliceHome } from "./user-config.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface SigningKey {
  name: string;
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64 (what the registry stores). */
  publicKey: string;
  path: string;
}

export function keysDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(spliceHome(env), "keys");
}

function keyFile(name: string, env: NodeJS.ProcessEnv): string {
  if (!NAME.test(name)) throw new CoreError("KEY_NOT_FOUND", `Invalid key name "${name}" (lowercase letters, digits and dashes).`);
  return join(keysDir(env), `${name}.key`);
}

function rawPublicKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

async function describe(name: string, path: string, privateKey: KeyObject): Promise<SigningKey> {
  const publicKey = rawPublicKey(privateKey);
  return { name, keyId: await keyIdOf(publicKey), publicKey, path };
}

/** Creates a new key. Never overwrites an existing one. */
export async function generateSigningKey(name = "default", env: NodeJS.ProcessEnv = process.env): Promise<SigningKey> {
  const path = keyFile(name, env);
  if (existsSync(path)) throw new CoreError("KEY_EXISTS", `A signing key named "${name}" already exists (${path}).`, { hint: "Use it, or choose another name: `splice keys generate <name>`." });
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(keysDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  return describe(name, path, privateKey);
}

function loadPrivate(name: string, env: NodeJS.ProcessEnv): { path: string; key: KeyObject } {
  const path = keyFile(name, env);
  if (!existsSync(path)) throw new CoreError("KEY_NOT_FOUND", `No signing key named "${name}" in ${keysDir(env)}.`, { hint: "Create one with `splice keys generate`." });
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw new CoreError("KEY_NOT_FOUND", `${path} is not an Ed25519 key.`);
  return { path, key };
}

export async function loadSigningKey(name = "default", env: NodeJS.ProcessEnv = process.env): Promise<SigningKey> {
  const { path, key } = loadPrivate(name, env);
  return describe(name, path, key);
}

export async function listSigningKeys(env: NodeJS.ProcessEnv = process.env): Promise<SigningKey[]> {
  if (!existsSync(keysDir(env))) return [];
  const names = readdirSync(keysDir(env))
    .filter((f) => f.endsWith(".key"))
    .map((f) => f.slice(0, -4))
    .filter((n) => NAME.test(n))
    .sort();
  return Promise.all(names.map((n) => loadSigningKey(n, env)));
}

/** Signs the payload for `id@version` with `integrity` (base64 Ed25519 signature). */
export function signPackage(name: string, id: string, version: string, integrity: string, env: NodeJS.ProcessEnv = process.env): string {
  const { key } = loadPrivate(name, env);
  return cryptoSign(null, Buffer.from(signaturePayload(id, version, integrity), "utf8"), key).toString("base64");
}

/**
 * Signs a published version with a local key and uploads the signature. Nothing is signed on the
 * registry's word alone: when `expectedIntegrity` is given (e.g. from packing the source locally)
 * the registry must report exactly that; otherwise the artifact is downloaded and fully verified
 * (SHA-256, size, package contents, metadata) before it is signed.
 */
export async function signPublishedVersion(
  client: RegistryClient,
  token: string,
  id: string,
  version: string,
  options: { key?: string; expectedIntegrity?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PackageSignature> {
  const env = options.env ?? process.env;
  const keyName = options.key ?? "default";
  const key = await loadSigningKey(keyName, env);
  const info = await client.getVersion(id, version);
  if (options.expectedIntegrity !== undefined && info.integrity !== options.expectedIntegrity) {
    throw new CoreError("INTEGRITY_MISMATCH", `The registry reports ${info.integrity} for ${id}@${version}, but the local package is ${options.expectedIntegrity}. Not signing.`, {
      hint: "Sign only the exact bytes you published: check out the source of that version and pass it with --dir.",
    });
  }
  if (options.expectedIntegrity === undefined) {
    const download = await client.downloadArtifact(id, version);
    const verification = await verifyArtifact({ bytes: download.bytes, expected: { id, version, integrity: info.integrity, size: info.size, manifest: info.manifest } });
    if (!verification.verified) {
      throw new CoreError("INTEGRITY_MISMATCH", `${id}@${version} failed verification; not signing.`, { details: verification.checks.filter((c) => c.status === "failed").map((c) => `${c.id}: ${c.message}`) });
    }
  }
  return client.addSignature(token, id, version, { keyId: key.keyId, signature: signPackage(keyName, id, version, info.integrity, env) });
}