import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { INTEGRITY_PATTERN, isValidRange, isValidVersion, normalizePermissions, parsePackageId, type Permissions } from "@spliceloom/spec";
import { CoreError } from "./errors.js";
import { expandRegistry, resolveRegistry } from "./user-config.js";

export const CONFIG_FILE = "splice.json";
export const LOCK_FILE = "splice.lock";
/** Lockfile name used before Phase 6. Still read; replaced by `splice.lock` on the next write. */
export const LEGACY_LOCK_FILE = "splice-lock.json";
export const STATE_DIR = ".splice";

/** `splice.json`: what the project wants. */
export interface ProjectConfig {
  specVersion: 1;
  /** Registry base URL. Overridden by the SPLICE_REGISTRY environment variable. */
  registry?: string;
  /** Package id → version range. */
  packages: Record<string, string>;
}

/** One resolved package in `splice.lock`. */
export interface LockEntry {
  version: string;
  /** `sha256-<hex>` of the artifact. Installs from the lockfile fail closed when the registry differs. */
  integrity: string;
  /** Artifact size in bytes (absent in lockfiles written before Phase 6). */
  size?: number;
  /**
   * Digest of the extracted files (`filesDigest`, Phase 8). Installed code whose files no longer
   * match is refused at load time and reinstalled by `splice install`. Absent in older lockfiles.
   */
  files?: string;
  /**
   * Registry base URL the package was resolved from. Always written by the installer; when read
   * from an older lockfile it is derived from `resolved`.
   */
  registry?: string;
  /** Artifact URL the package was downloaded from. */
  resolved: string;
  /**
   * Permissions granted when the package was installed (Phase 5+). The runtime refuses to run a
   * package whose manifest requests more. Absent in older lockfiles (treated as granted then).
   */
  permissions?: Permissions;
}

/** `splice.lock`: exactly what is installed, so another machine can install the same bytes. */
export interface Lockfile {
  lockfileVersion: 1;
  packages: Record<string, LockEntry>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function invalid(file: string, problem: string): CoreError {
  return new CoreError("INVALID_PROJECT", `${file} is invalid: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid(CONFIG_FILE, "not valid JSON");
  }
  if (!isRecord(raw) || raw.specVersion !== 1) throw invalid(CONFIG_FILE, 'expected {"specVersion": 1, ...}');
  if (raw.registry !== undefined && typeof raw.registry !== "string") throw invalid(CONFIG_FILE, "registry must be a string");
  if (typeof raw.registry === "string") {
    try {
      expandRegistry(raw.registry);
    } catch (error) {
      throw invalid(CONFIG_FILE, (error as Error).message);
    }
  }
  const packages = raw.packages ?? {};
  if (!isRecord(packages)) throw invalid(CONFIG_FILE, "packages must be an object");
  for (const [id, range] of Object.entries(packages)) {
    try {
      parsePackageId(id);
    } catch {
      throw invalid(CONFIG_FILE, `invalid package name "${id}"`);
    }
    if (typeof range !== "string" || !isValidRange(range)) throw invalid(CONFIG_FILE, `invalid range for ${id}`);
  }
  const config: ProjectConfig = { specVersion: 1, packages: packages as Record<string, string> };
  if (typeof raw.registry === "string") config.registry = raw.registry;
  return config;
}

/** Registry base URL of a `resolved` download URL (`<registry>/packages/<ns>/<name>/<v>/download`). */
function registryOf(resolved: string): string {
  const at = resolved.lastIndexOf("/packages/");
  return at > 0 ? resolved.slice(0, at) : resolved;
}

function parseLock(text: string, file: string): Lockfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw invalid(file, "not valid JSON");
  }
  if (!isRecord(raw) || raw.lockfileVersion !== 1 || !isRecord(raw.packages)) {
    throw invalid(file, 'expected {"lockfileVersion": 1, "packages": {...}}');
  }
  const packages: Record<string, LockEntry> = {};
  for (const [id, entry] of Object.entries(raw.packages)) {
    try {
      parsePackageId(id);
    } catch {
      throw invalid(file, `invalid package name "${id}"`);
    }
    const e = entry as Partial<LockEntry> | null;
    if (
      !e ||
      typeof e.version !== "string" ||
      !isValidVersion(e.version) ||
      typeof e.integrity !== "string" ||
      !INTEGRITY_PATTERN.test(e.integrity) ||
      typeof e.resolved !== "string" ||
      (e.registry !== undefined && typeof e.registry !== "string") ||
      (e.size !== undefined && (!Number.isSafeInteger(e.size) || e.size < 0)) ||
      (e.files !== undefined && (typeof e.files !== "string" || !INTEGRITY_PATTERN.test(e.files)))
    ) {
      throw invalid(file, `malformed entry for ${id}`);
    }
    const parsed: LockEntry = { version: e.version, integrity: e.integrity, registry: e.registry ?? registryOf(e.resolved), resolved: e.resolved };
    if (e.size !== undefined) parsed.size = e.size;
    if (e.files !== undefined) parsed.files = e.files;
    if (e.permissions !== undefined) {
      const errors: string[] = [];
      parsed.permissions = normalizePermissions(e.permissions, errors, `${id}.permissions`);
      if (errors.length > 0) throw invalid(file, `malformed permissions for ${id}: ${errors.join("; ")}`);
    }
    packages[id] = parsed;
  }
  return { lockfileVersion: 1, packages };
}

/** Stable key order for lock entries, so lockfiles diff cleanly. */
function serializeEntry(entry: LockEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { version: entry.version, integrity: entry.integrity };
  if (entry.size !== undefined) out.size = entry.size;
  if (entry.files !== undefined) out.files = entry.files;
  out.registry = entry.registry ?? registryOf(entry.resolved);
  out.resolved = entry.resolved;
  if (entry.permissions !== undefined) out.permissions = entry.permissions;
  return out;
}

/** A directory containing `splice.json`. */
export class SpliceProject {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Walks up from `cwd` to find the nearest project. */
  static async find(cwd: string): Promise<SpliceProject | null> {
    let dir = resolve(cwd);
    for (;;) {
      if (await exists(join(dir, CONFIG_FILE))) return new SpliceProject(dir);
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  static async require(cwd: string): Promise<SpliceProject> {
    const project = await SpliceProject.find(cwd);
    if (!project) {
      throw new CoreError("NOT_A_PROJECT", `No ${CONFIG_FILE} found in ${resolve(cwd)} or any parent directory.`, {
        hint: "Run `splice init` to create a Splice project here.",
      });
    }
    return project;
  }

  /**
   * Creates `splice.json` in `dir`. Existing projects are left untouched. `splice.lock` and
   * `.splice/` are created by the first install, not here.
   */
  static async init(dir: string, options: { registry?: string } = {}): Promise<{ project: SpliceProject; created: boolean }> {
    const root = resolve(dir);
    const project = new SpliceProject(root);
    if (await exists(project.configPath)) return { project, created: false };
    await mkdir(root, { recursive: true });
    const config: ProjectConfig = { specVersion: 1, packages: {} };
    if (options.registry) config.registry = options.registry;
    await project.writeConfig(config);
    return { project, created: true };
  }

  get configPath(): string {
    return join(this.root, CONFIG_FILE);
  }

  get lockPath(): string {
    return join(this.root, LOCK_FILE);
  }

  get legacyLockPath(): string {
    return join(this.root, LEGACY_LOCK_FILE);
  }

  get stateDir(): string {
    return join(this.root, STATE_DIR);
  }

  get packagesDir(): string {
    return join(this.stateDir, "packages");
  }

  packageDir(id: string): string {
    const { namespace, name } = parsePackageId(id);
    return join(this.packagesDir, `@${namespace}`, name);
  }

  async readConfig(): Promise<ProjectConfig> {
    return parseConfig(await readFile(this.configPath, "utf8"));
  }

  async writeConfig(config: ProjectConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, { ...config, packages: sortKeys(config.packages) });
  }

  /** Reads `splice.lock`, falling back to a pre-Phase-6 `splice-lock.json`. */
  async readLock(): Promise<Lockfile> {
    if (await exists(this.lockPath)) return parseLock(await readFile(this.lockPath, "utf8"), LOCK_FILE);
    if (await exists(this.legacyLockPath)) return parseLock(await readFile(this.legacyLockPath, "utf8"), LEGACY_LOCK_FILE);
    return { lockfileVersion: 1, packages: {} };
  }

  /**
   * Writes `splice.lock` (and retires a legacy `splice-lock.json`). A project without packages has
   * no lockfile: writing an empty lock removes it.
   */
  async writeLock(lock: Lockfile): Promise<void> {
    const ids = Object.keys(lock.packages).sort();
    if (ids.length === 0) {
      await rm(this.lockPath, { force: true });
    } else {
      const packages = Object.fromEntries(ids.map((id) => [id, serializeEntry(lock.packages[id]!)]));
      await writeJsonAtomic(this.lockPath, { lockfileVersion: 1, packages });
    }
    await rm(this.legacyLockPath, { force: true });
  }

  /** Registry URL precedence: override → SPLICE_REGISTRY → splice.json → ~/.splice/config.json → default. */
  async registryUrl(env: NodeJS.ProcessEnv = process.env, override?: string): Promise<string> {
    const config = await this.readConfig();
    return (await resolveRegistry({ override, env, projectRegistry: config.registry })).url;
  }
}
