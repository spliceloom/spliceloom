/**
 * Per-user Splice state in SPLICE_HOME (default ~/.splice):
 *   config.json       { "registry": "<url>" }                     — user default registry
 *   credentials.json  { "registries": { "<url>": { token, user } } } — registry tokens (mode 0600)
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CoreError } from "./errors.js";

/** The live production registry (Cloudflare Worker on its custom domain). */
export const PRODUCTION_REGISTRY_URL = "https://registry.spliceloom.com";
export const LOCAL_REGISTRY_URL = "http://127.0.0.1:8787";
/** Names accepted wherever a registry URL is expected. */
export const REGISTRY_ALIASES: Readonly<Record<string, string>> = {
  production: PRODUCTION_REGISTRY_URL,
  local: LOCAL_REGISTRY_URL,
};
/** Used when nothing else is configured. */
export const DEFAULT_REGISTRY_URL = PRODUCTION_REGISTRY_URL;

export type RegistrySource = "flag" | "env" | "project" | "user" | "default";

export interface UserConfig {
  registry?: string;
}

interface CredentialEntry {
  token: string;
  user: string;
  savedAt: string;
}

interface Credentials {
  version: 1;
  registries: Record<string, CredentialEntry>;
}

export function spliceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPLICE_HOME ?? join(homedir(), ".splice");
}

/** Expands aliases (`local`, `production`) and normalizes an http(s) registry URL. */
export function expandRegistry(value: string): string {
  const raw = REGISTRY_ALIASES[value.trim()] ?? value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoreError("INVALID_CONFIG", `Invalid registry "${value}". Use an http(s) URL or one of: ${Object.keys(REGISTRY_ALIASES).join(", ")}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CoreError("INVALID_CONFIG", `Registry URL must use http or https: "${value}"`);
  }
  if (url.username || url.password) throw new CoreError("INVALID_CONFIG", "Registry URL must not contain credentials");
  return url.href.replace(/\/+$/, "");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CoreError("INVALID_CONFIG", `${path} is not valid JSON`);
  }
}

async function writePrivateJson(path: string, dir: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  // On POSIX make sure permissions are tight even if the file pre-existed. (No-op on Windows,
  // where the file inherits the user-profile ACL.)
  await chmod(path, 0o600).catch(() => {});
}

export async function readUserConfig(env: NodeJS.ProcessEnv = process.env): Promise<UserConfig> {
  const raw = await readJsonFile<Record<string, unknown>>(join(spliceHome(env), "config.json"));
  if (!raw) return {};
  const config: UserConfig = {};
  if (typeof raw.registry === "string") config.registry = raw.registry;
  return config;
}

export async function writeUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = spliceHome(env);
  await writePrivateJson(join(home, "config.json"), home, config);
}

/**
 * Registry URL precedence: --registry → SPLICE_REGISTRY → splice.json → ~/.splice/config.json → default.
 */
export async function resolveRegistry(options: {
  override?: string | undefined;
  env?: NodeJS.ProcessEnv;
  projectRegistry?: string | undefined;
}): Promise<{ url: string; source: RegistrySource }> {
  const env = options.env ?? process.env;
  if (options.override) return { url: expandRegistry(options.override), source: "flag" };
  if (env.SPLICE_REGISTRY) return { url: expandRegistry(env.SPLICE_REGISTRY), source: "env" };
  if (options.projectRegistry) return { url: expandRegistry(options.projectRegistry), source: "project" };
  const user = await readUserConfig(env);
  if (user.registry) return { url: expandRegistry(user.registry), source: "user" };
  return { url: DEFAULT_REGISTRY_URL, source: "default" };
}

function credentialsPath(env: NodeJS.ProcessEnv): string {
  return join(spliceHome(env), "credentials.json");
}

async function readCredentials(env: NodeJS.ProcessEnv): Promise<Credentials> {
  const raw = await readJsonFile<Partial<Credentials>>(credentialsPath(env));
  const registries = raw && typeof raw.registries === "object" && raw.registries !== null ? raw.registries : {};
  return { version: 1, registries };
}

export async function saveCredential(registryUrl: string, token: string, user: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const creds = await readCredentials(env);
  creds.registries[expandRegistry(registryUrl)] = { token, user, savedAt: new Date().toISOString() };
  await writePrivateJson(credentialsPath(env), spliceHome(env), creds);
}

/** Removes the stored token for a registry. Returns false when none was stored. */
export async function removeCredential(registryUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const creds = await readCredentials(env);
  const key = expandRegistry(registryUrl);
  if (!(key in creds.registries)) return false;
  delete creds.registries[key];
  await writePrivateJson(credentialsPath(env), spliceHome(env), creds);
  return true;
}

/** Token for a registry: SPLICE_TOKEN (e.g. CI) wins over the stored credential. */
export async function getToken(
  registryUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: "env" | "credentials"; user?: string } | null> {
  if (env.SPLICE_TOKEN) return { token: env.SPLICE_TOKEN, source: "env" };
  const entry = (await readCredentials(env)).registries[expandRegistry(registryUrl)];
  return entry ? { token: entry.token, source: "credentials", user: entry.user } : null;
}
