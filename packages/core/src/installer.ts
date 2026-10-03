import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  INTEGRITY_PATTERN,
  defaultVerifiers,
  describePermissions,
  downloadPath,
  emptyPermissions,
  filesDigest,
  isEmptyPermissions,
  latestVersion,
  maxSatisfying,
  parsePackageId,
  parsePackageRef,
  parseToolRef,
  satisfies,
  ungrantedPermissions,
  verifyArtifact,
  type BundleFile,
  type Manifest,
  type Permissions,
} from "@spliceloom/spec";
import { RuntimeError, loadPackage, type LoadedPackage } from "@spliceloom/runtime";
import type { ArtifactCache } from "./cache.js";
import { CoreError } from "./errors.js";
import { installedFilesDigest } from "./pack.js";
import type { LockEntry, SpliceProject } from "./project.js";
import type { RegistryClient } from "./registry-client.js";

export type InstallStep = "resolving" | "downloading" | "verifying" | "installing";

export interface AddOptions {
  onStep?: (step: InstallStep, detail: string) => void;
  /**
   * Consent for the permissions a package requests (file, network, environment access). Packages
   * requesting no permissions install without it. `true` accepts; a function decides per package.
   * Upgrades that request more than was granted before need consent again.
   */
  acceptPermissions?: boolean | ((requested: Permissions, pkg: string) => boolean | Promise<boolean>);
  /**
   * Local artifact cache. Verified artifacts are stored there and reused (still fully verified)
   * instead of downloading again; when the registry is unreachable, locked versions can be
   * installed from it. `null`/omitted: no cache.
   */
  cache?: ArtifactCache | null;
  /** Refuse versions without a verified publisher signature (`--require-signed`). */
  requireSigned?: boolean;
  /**
   * Accept a version signed by a different key than the installed one, or unsigned when the
   * installed one was signed (`--allow-signer-change`). Refused by default.
   */
  allowSignerChange?: boolean;
}

export type UpdateOptions = AddOptions;

export interface AddResult {
  id: string;
  version: string;
  integrity: string;
  manifest: Manifest;
  /** Previously installed version, when this was an upgrade/downgrade. */
  previousVersion?: string;
  /** True when the requested version was already installed and nothing changed. */
  alreadyInstalled: boolean;
  /** True when the artifact came from the local cache instead of a download (it was still verified). */
  fromCache?: boolean;
  /** Key id of the verified publisher signature; absent when the version is unsigned. */
  signedBy?: string;
  /**
   * True when the registry was unreachable and the locked version was installed from the local
   * cache. The artifact was verified against the lockfile's SHA-256; registry metadata could not
   * be compared.
   */
  offline?: boolean;
}

export interface InstalledPackage {
  id: string;
  range: string | null;
  version: string | null;
  /** `ok`: installed and valid; `missing`: in splice.json/lock but not on disk; `invalid`: on disk but fails validation. */
  status: "ok" | "missing" | "invalid";
}

export interface OutdatedPackage {
  id: string;
  /** Range from splice.json (null when the package is only in the lockfile). */
  range: string | null;
  /** Locked version (null when not installed yet). */
  current: string | null;
  /** Highest registry version satisfying the range — what `splice update` installs. */
  wanted: string | null;
  /** Highest stable registry version, regardless of the range. */
  latest: string | null;
  /**
   * `up-to-date`: current is the newest version in range; `update-available`: `splice update` would
   * install `wanted`; `not-installed`: declared but not locked; `no-match`: no registry version
   * satisfies the range.
   */
  status: "up-to-date" | "update-available" | "not-installed" | "no-match";
}

export interface UpdateResult {
  id: string;
  range: string;
  /** Version before the update (null when it was not installed). */
  from: string | null;
  /** Version after the update (null when no version satisfies the range). */
  to: string | null;
  /** Highest stable registry version, regardless of the range. */
  latest: string | null;
  status: "updated" | "up-to-date" | "no-match";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface InstallContext {
  project: SpliceProject;
  client: RegistryClient;
  options: AddOptions;
  step: (step: InstallStep, detail: string) => void;
}

function contextFor(project: SpliceProject, client: RegistryClient, options: AddOptions): InstallContext {
  return { project, client, options, step: options.onStep ?? (() => {}) };
}

/** True when the user typed a version/range (`@ns/name@^1.0.0`), not just `@ns/name`. */
function hasExplicitRange(refInput: string): boolean {
  return refInput.trim().lastIndexOf("@") > 0;
}

/** Registry down (network) or temporarily unavailable (HTTP 503): locked versions may come from the cache. */
function isUnreachable(error: unknown): boolean {
  return error instanceof CoreError && (error.code === "REGISTRY_UNREACHABLE" || error.code === "REGISTRY_UNAVAILABLE");
}

/**
 * Returns the installed package when it is on disk, valid, at `version` and — when the lock
 * records a files digest — byte-identical to what was verified at install.
 */
async function installedAt(project: SpliceProject, id: string, version: string, entry?: LockEntry): Promise<LoadedPackage | null> {
  try {
    const pkg = await loadPackage(project.packageDir(id));
    if (pkg.manifest.version !== version) return null;
    if (entry?.files && (await installedFilesDigest(project.packageDir(id))) !== entry.files) return null;
    return pkg;
  } catch {
    return null;
  }
}

/**
 * Refuses to hand out installed code that changed after its verified installation (files digest
 * in splice.lock). Lock entries written before Phase 8 carry no digest and are not checked.
 */
export async function assertInstalledIntact(project: SpliceProject, id: string, entry: LockEntry | undefined): Promise<void> {
  if (!entry?.files) return;
  const actual = await installedFilesDigest(project.packageDir(id));
  if (actual !== entry.files) {
    throw new CoreError("INSTALLED_PACKAGE_MODIFIED", `Installed files of ${id}@${entry.version} were modified after verification; refusing to run them.`, {
      hint: "Restore the verified copy with `splice install` (or `splice verify` to inspect).",
    });
  }
}

interface InstallRequest {
  id: string;
  version: string;
  /** Range to record in splice.json; null leaves splice.json unchanged. */
  saveRange: string | null;
  /** The registry could not be reached: only the locked version, from the cache, is possible. */
  offline?: boolean;
}

/**
 * The single install pipeline used by `add`, lockfile installs and `update`:
 * metadata (pinned to the lockfile when the version is locked) → artifact (cache or download) →
 * verification → permission consent → staged install → atomic swap + lockfile update.
 * Any failure leaves the previously installed version, splice.json and splice.lock unchanged.
 */
async function installVersion(ctx: InstallContext, req: InstallRequest): Promise<AddResult> {
  const { project, client, options, step } = ctx;
  const { id, version } = req;
  const label = `${id}@${version}`;
  const config = await project.readConfig();
  const lock = await project.readLock();
  const current = lock.packages[id];
  const locked = current?.version === version ? current : undefined;

  if (locked) {
    const installed = await installedAt(project, id, version, locked);
    if (installed) {
      if (req.saveRange !== null && config.packages[id] !== req.saveRange) {
        config.packages[id] = req.saveRange;
        await project.writeConfig(config);
      }
      const result: AddResult = { id, version, integrity: locked.integrity, manifest: installed.manifest, alreadyInstalled: true };
      if (req.offline) result.offline = true;
      if (locked.signedBy) result.signedBy = locked.signedBy;
      return result;
    }
  }

  // 1. What the artifact must be. A locked version is pinned to the lockfile's SHA-256 and size.
  let expected: { integrity: string; size?: number; manifest?: Manifest; signatures?: NonNullable<Awaited<ReturnType<RegistryClient["getVersion"]>>["signatures"]> };
  if (req.offline) {
    if (!locked) throw new CoreError("REGISTRY_UNREACHABLE", `Could not reach the registry at ${client.baseUrl} to resolve ${label}.`);
    expected = { integrity: locked.integrity };
    if (locked.size !== undefined) expected.size = locked.size;
    // Offline: the bytes are pinned by the lockfile SHA-256; the signature was verified when locked.
    if (options.requireSigned && !locked.signedBy) {
      throw new CoreError("SIGNATURE_REQUIRED", `${label} was not signed when it was locked, and signatures are required.`);
    }
  } else {
    let info;
    try {
      info = await client.getVersion(id, version);
    } catch (error) {
      if (locked && error instanceof CoreError && error.code === "PACKAGE_NOT_FOUND") {
        throw new CoreError("LOCK_MISMATCH", `${label} is locked in splice.lock but the registry (${client.baseUrl}) does not have it.`, {
          details: [`locked from: ${locked.registry ?? locked.resolved}`],
          hint: "Check the registry setting (`splice config get registry`) or update the lock with `splice update`.",
        });
      }
      throw error;
    }
    if (!INTEGRITY_PATTERN.test(info.integrity)) {
      throw new CoreError("REGISTRY_ERROR", `Registry returned an invalid integrity for ${label}`);
    }
    if (locked && (info.integrity !== locked.integrity || (locked.size !== undefined && info.size !== locked.size))) {
      throw new CoreError("LOCK_MISMATCH", `The registry serves a different artifact for ${label} than splice.lock records. Refusing to install.`, {
        details: [
          `splice.lock: ${locked.integrity}${locked.size !== undefined ? ` (${locked.size} bytes)` : ""}`,
          `registry:    ${info.integrity} (${info.size} bytes)`,
        ],
        hint: "Published versions are immutable, so this indicates a different or compromised registry. Nothing was changed.",
      });
    }
    expected = { integrity: info.integrity, size: info.size, manifest: info.manifest };
    if (info.signatures) expected.signatures = info.signatures;
  }

  // 2. The artifact: verified cache entry, or a download.
  let bytes: Uint8Array | null = (await options.cache?.get(expected.integrity)) ?? null;
  const fromCache = bytes !== null;
  if (bytes) {
    step("downloading", `${label} (local cache)`);
  } else if (req.offline) {
    throw new CoreError("REGISTRY_UNREACHABLE", `Could not reach the registry at ${client.baseUrl}, and ${label} is not in the local cache.`, {
      hint: options.cache ? "Connect to the registry once to install it; it is cached after a verified install." : "The local artifact cache is disabled.",
    });
  } else {
    step("downloading", label);
    const download = await client.downloadArtifact(id, version);
    if (download.integrity !== null && download.integrity !== expected.integrity) {
      throw new CoreError("INTEGRITY_MISMATCH", `Integrity check failed for ${label}`, {
        details: [`metadata: ${expected.integrity}`, `download header: ${download.integrity}`],
      });
    }
    bytes = download.bytes;
  }

  // 3. Verified before anything touches the project; there is no way to skip this (cached bytes included).
  step("verifying", expected.integrity);
  const verification = await verifyArtifact({ bytes, expected: { id, version, ...expected } }, defaultVerifiers({ requireSigned: options.requireSigned === true && !req.offline }));
  if (!verification.verified || !verification.files || !verification.manifest) {
    const failed = verification.checks.find((c) => c.status === "failed");
    const integrityProblem = failed?.id === "sha256" || failed?.id === "size";
    const details = verification.checks.filter((c) => c.status !== "skipped").map((c) => `${c.id}: ${c.message}`);
    if (failed?.id === "signature") {
      const required = /signatures are required/.test(failed.message);
      throw new CoreError(required ? "SIGNATURE_REQUIRED" : "SIGNATURE_INVALID", required ? `${label} is not signed, and signatures are required.` : `Signature check failed for ${label}. Refusing to install.`, {
        details,
        hint: required ? "Install without --require-signed, or ask the publisher to sign it (`splice sign`)." : "A signature that does not match the artifact means the package or its metadata was tampered with. Nothing was changed.",
      });
    }
    throw new CoreError(
      integrityProblem ? "INTEGRITY_MISMATCH" : "INVALID_PACKAGE",
      integrityProblem ? `Integrity check failed for ${label}` : `Verification failed for ${label}`,
      { details },
    );
  }
  const manifest = verification.manifest;
  // Offline installs keep the signer recorded when the version was locked.
  const signedBy = req.offline ? locked?.signedBy : verification.signedBy;
  // Trust on first use: the key that signed the installed version must sign what replaces it.
  if (current?.signedBy && signedBy !== current.signedBy && !options.allowSignerChange) {
    throw new CoreError("SIGNER_CHANGED", `${label} is ${signedBy ? `signed by ${signedBy}` : "unsigned"}, but the installed ${id}@${current.version} was signed by ${current.signedBy}. Refusing to install.`, {
      hint: "This happens when the publisher rotated or revoked their key — or when someone else published. Check the namespace keys (`splice keys list`), then rerun with --allow-signer-change if you trust the change.",
    });
  }
  if (!fromCache) await options.cache?.put(expected.integrity, bytes);

  // 4. Permissions are never granted implicitly.
  const granted = current?.permissions ?? emptyPermissions();
  if (!isEmptyPermissions(ungrantedPermissions(manifest.permissions, granted))) {
    const accepted =
      typeof options.acceptPermissions === "function"
        ? await options.acceptPermissions(manifest.permissions, label)
        : options.acceptPermissions === true;
    if (!accepted) {
      throw new CoreError("PERMISSIONS_NOT_ACCEPTED", `${label} requests permissions that have not been granted`, {
        details: describePermissions(manifest.permissions),
        hint: "Review them, then install with --accept-permissions (SDK: { acceptPermissions: true }).",
      });
    }
  }

  // 5. Install and record, atomically.
  const entry: LockEntry = {
    version,
    integrity: expected.integrity,
    size: bytes.byteLength,
    files: await filesDigest(verification.files),
    registry: req.offline && locked?.registry ? locked.registry : client.baseUrl,
    resolved: req.offline && locked ? locked.resolved : client.url(downloadPath(id, version)),
    permissions: manifest.permissions,
  };
  if (signedBy) entry.signedBy = signedBy;
  await swapInstall(ctx, id, verification.files, async () => {
    if (req.saveRange !== null) config.packages[id] = req.saveRange;
    lock.packages[id] = entry;
    await project.writeConfig(config);
    await project.writeLock(lock);
  });

  const result: AddResult = { id, version, integrity: expected.integrity, manifest, alreadyInstalled: false };
  if (current && current.version !== version) result.previousVersion = current.version;
  if (fromCache) result.fromCache = true;
  if (req.offline) result.offline = true;
  if (signedBy) result.signedBy = signedBy;
  return result;
}

/**
 * Writes the verified files to a staging directory, validates them, then swaps them into place.
 * The previous version is moved aside (not deleted) until `commit` (splice.json + splice.lock)
 * succeeds; on any failure it is moved back and the project files are restored.
 */
async function swapInstall(ctx: InstallContext, id: string, files: BundleFile[], commit: () => Promise<void>): Promise<void> {
  const { project, step } = ctx;
  const { name } = parsePackageId(id);
  const targetDir = project.packageDir(id);
  const tmpRoot = join(project.stateDir, "tmp");
  const suffix = randomBytes(6).toString("hex");
  const stagingDir = join(tmpRoot, `${name}-${suffix}`);
  const backupDir = join(tmpRoot, `${name}-${suffix}-previous`);
  const previousConfig = await project.readConfig();
  const previousLock = await project.readLock();

  step("installing", relative(project.root, targetDir).split(sep).join("/"));
  let backedUp = false;
  let swapped = false;
  try {
    for (const file of files) {
      const dest = join(stagingDir, ...file.path.split("/"));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content);
    }
    try {
      await loadPackage(stagingDir);
    } catch (error) {
      if (error instanceof RuntimeError) throw new CoreError("INVALID_PACKAGE", error.message, { details: error.details });
      throw error;
    }
    await mkdir(dirname(targetDir), { recursive: true });
    if (await exists(targetDir)) {
      await rename(targetDir, backupDir);
      backedUp = true;
    }
    await rename(stagingDir, targetDir);
    swapped = true;
    await commit();
  } catch (error) {
    // Roll back: the previous version and project files are restored exactly.
    if (swapped) await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    if (backedUp) await rename(backupDir, targetDir).catch(() => {});
    await project.writeConfig(previousConfig).catch(() => {});
    await project.writeLock(previousLock).catch(() => {});
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
    await rmdir(tmpRoot).catch(() => {});
  }
}

/** Registry metadata for a package, with a clearer not-found message. */
async function packageVersions(client: RegistryClient, id: string, name: string): Promise<string[]> {
  try {
    return (await client.getPackage(id)).versions.map((v) => v.version);
  } catch (error) {
    if (error instanceof CoreError && error.code === "PACKAGE_NOT_FOUND") {
      throw new CoreError("PACKAGE_NOT_FOUND", `Package ${id} was not found in the registry (${client.baseUrl}).`, {
        hint: `Try \`splice search ${name}\`.`,
      });
    }
    throw error;
  }
}

/**
 * Resolves, downloads, verifies and installs a package into the project.
 *
 * - `@ns/name` installs the newest stable version (recorded as `^version`).
 * - `@ns/name@<range>` keeps the locked version when it satisfies the range (use `update` to move
 *   to the newest version in range); otherwise installs the highest matching version.
 * - When the registry is unreachable, the locked version is installed from the verified local cache.
 */
export async function addPackage(project: SpliceProject, client: RegistryClient, refInput: string, options: AddOptions = {}): Promise<AddResult> {
  const ctx = contextFor(project, client, options);
  const ref = parsePackageRef(refInput);
  const explicit = hasExplicitRange(refInput) && ref.range !== "latest";
  const current = (await project.readLock()).packages[ref.id];

  ctx.step("resolving", ref.id);
  let available: string[];
  try {
    available = await packageVersions(client, ref.id, ref.name);
  } catch (error) {
    // Offline: the locked version, if it is what was asked for.
    if (isUnreachable(error) && current && (!explicit || satisfies(current.version, ref.range))) {
      const saveRange = explicit ? ref.range : ((await project.readConfig()).packages[ref.id] ?? `^${current.version}`);
      return installVersion(ctx, { id: ref.id, version: current.version, saveRange, offline: true });
    }
    throw error;
  }

  let version: string | null;
  if (explicit && current && available.includes(current.version) && satisfies(current.version, ref.range)) {
    version = current.version;
  } else {
    version = maxSatisfying(available, ref.range);
  }
  if (!version) {
    throw new CoreError("NO_MATCHING_VERSION", `No version of ${ref.id} matches "${ref.range}".`, {
      details: [`available: ${available.join(", ") || "none"}`],
    });
  }
  const saveRange = ref.range === "latest" || ref.range === "*" ? `^${version}` : ref.range;
  return installVersion(ctx, { id: ref.id, version, saveRange });
}

/**
 * Installs the project exactly as recorded: every package in splice.lock at its locked version and
 * SHA-256 (fail closed when the registry serves anything else), plus packages declared in
 * splice.json that are not locked yet (resolved from their range). Packages already installed at
 * the locked version are left alone. Offline, locked versions come from the verified local cache.
 */
export async function installProject(project: SpliceProject, client: RegistryClient, options: AddOptions = {}): Promise<AddResult[]> {
  const ctx = contextFor(project, client, options);
  const config = await project.readConfig();
  const lock = await project.readLock();
  const ids = [...new Set([...Object.keys(config.packages), ...Object.keys(lock.packages)])].sort();
  const results: AddResult[] = [];

  for (const id of ids) {
    const entry = lock.packages[id];
    const range = config.packages[id];
    if (!entry) {
      results.push(await addPackage(project, client, `${id}@${range}`, options));
      continue;
    }
    if (range !== undefined && !satisfies(entry.version, range)) {
      throw new CoreError("LOCK_MISMATCH", `splice.lock pins ${id}@${entry.version}, which does not satisfy "${range}" in splice.json.`, {
        hint: `Run \`splice update ${id}\` to lock a version that matches.`,
      });
    }
    ctx.step("resolving", `${id}@${entry.version} (locked)`);
    try {
      results.push(await installVersion(ctx, { id, version: entry.version, saveRange: null }));
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      results.push(await installVersion(ctx, { id, version: entry.version, saveRange: null, offline: true }));
    }
  }
  // A pre-Phase-6 splice-lock.json becomes splice.lock even when nothing had to be installed.
  if (results.length > 0 && !(await exists(project.lockPath))) await project.writeLock(await project.readLock());
  return results;
}

/** Selects the packages `outdated`/`update` look at: all of splice.json, or the given ids. */
async function selectPackages(project: SpliceProject, ids: string[]): Promise<Array<{ id: string; range: string }>> {
  const config = await project.readConfig();
  if (ids.length === 0) return Object.keys(config.packages).sort().map((id) => ({ id, range: config.packages[id]! }));
  return ids.map((input) => {
    const { id } = parsePackageId(input);
    const range = config.packages[id];
    if (range === undefined) throw new CoreError("NOT_INSTALLED", `${id} is not in splice.json.`, { hint: `Run \`splice add ${id}\`.` });
    return { id, range };
  });
}

/** Compares locked versions with the registry. Read-only. Needs the registry (no offline mode). */
export async function outdatedPackages(project: SpliceProject, client: RegistryClient, ids: string[] = []): Promise<OutdatedPackage[]> {
  const lock = await project.readLock();
  const result: OutdatedPackage[] = [];
  for (const { id, range } of await selectPackages(project, ids)) {
    const available = await packageVersions(client, id, parsePackageId(id).name);
    const current = lock.packages[id]?.version ?? null;
    const wanted = maxSatisfying(available, range);
    const status: OutdatedPackage["status"] = !wanted ? "no-match" : current === null ? "not-installed" : wanted === current ? "up-to-date" : "update-available";
    result.push({ id, range, current, wanted, latest: latestVersion(available), status });
  }
  return result;
}

/**
 * Updates packages to the highest registry version allowed by their splice.json range (the range
 * itself is not changed). Each package goes through the full install pipeline and is swapped in
 * atomically: if anything fails, that package's previous version stays installed and locked, and
 * the error is thrown (packages updated before it remain updated).
 */
export async function updatePackages(project: SpliceProject, client: RegistryClient, ids: string[] = [], options: UpdateOptions = {}): Promise<UpdateResult[]> {
  const ctx = contextFor(project, client, options);
  const results: UpdateResult[] = [];
  for (const { id, range } of await selectPackages(project, ids)) {
    ctx.step("resolving", `${id}@${range}`);
    const available = await packageVersions(client, id, parsePackageId(id).name);
    const latest = latestVersion(available);
    const from = (await project.readLock()).packages[id]?.version ?? null;
    const wanted = maxSatisfying(available, range);
    if (!wanted) {
      results.push({ id, range, from, to: null, latest, status: "no-match" });
      continue;
    }
    const installed = await installVersion(ctx, { id, version: wanted, saveRange: null });
    results.push({ id, range, from, to: wanted, latest, status: installed.alreadyInstalled ? "up-to-date" : "updated" });
  }
  return results;
}

/** Removes a package from disk, splice.json and the lockfile. */
export async function removePackage(project: SpliceProject, idInput: string): Promise<{ id: string; version: string | null }> {
  const { id } = parsePackageId(idInput);
  const config = await project.readConfig();
  const lock = await project.readLock();
  const dir = project.packageDir(id);
  const onDisk = await exists(dir);
  if (!(id in config.packages) && !(id in lock.packages) && !onDisk) {
    throw new CoreError("NOT_INSTALLED", `${id} is not installed.`, { hint: "Run `splice list` to see installed packages." });
  }
  const version = lock.packages[id]?.version ?? null;
  await rm(dir, { recursive: true, force: true });
  // Remove directories that become empty (namespace, .splice/packages, .splice).
  for (const emptyDir of [dirname(dir), project.packagesDir, project.stateDir]) {
    if ((await exists(emptyDir)) && (await readdir(emptyDir)).length === 0) await rmdir(emptyDir);
  }
  delete config.packages[id];
  delete lock.packages[id];
  await project.writeConfig(config);
  await project.writeLock(lock);
  return { id, version };
}

/** Lists packages declared in splice.json or the lockfile, with their on-disk status. */
export async function listPackages(project: SpliceProject): Promise<InstalledPackage[]> {
  const config = await project.readConfig();
  const lock = await project.readLock();
  const ids = [...new Set([...Object.keys(config.packages), ...Object.keys(lock.packages)])].sort();
  const result: InstalledPackage[] = [];
  for (const id of ids) {
    const entry = lock.packages[id];
    let status: InstalledPackage["status"] = "ok";
    if (!entry || !(await exists(project.packageDir(id)))) {
      status = "missing";
    } else {
      try {
        const pkg = await loadPackage(project.packageDir(id));
        if (pkg.manifest.version !== entry.version) status = "invalid";
        // A package whose (possibly edited) manifest requests more than was granted is not usable.
        if (entry.permissions && !isEmptyPermissions(ungrantedPermissions(pkg.manifest.permissions, entry.permissions))) status = "invalid";
        // Files changed after the verified installation.
        if (entry.files && (await installedFilesDigest(project.packageDir(id))) !== entry.files) status = "invalid";
      } catch {
        status = "invalid";
      }
    }
    result.push({ id, range: config.packages[id] ?? null, version: entry?.version ?? null, status });
  }
  return result;
}

/** Resolves `example.hello` / `@splice/example.hello` to an installed package and tool name. */
export async function resolveInstalledTool(
  project: SpliceProject,
  refInput: string,
): Promise<{ pkg: LoadedPackage; tool: string }> {
  const ref = parseToolRef(refInput);
  const lock = await project.readLock();
  const candidates = Object.keys(lock.packages).filter((id) => {
    const parsed = parsePackageId(id);
    return parsed.name === ref.name && (ref.namespace === undefined || parsed.namespace === ref.namespace);
  });
  if (candidates.length === 0) {
    const shown = ref.namespace ? `@${ref.namespace}/${ref.name}` : ref.name;
    throw new CoreError("NOT_INSTALLED", `No installed package named "${shown}".`, {
      hint: ref.namespace ? `Run \`splice add ${shown}\`.` : `Run \`splice search ${ref.name}\` and \`splice add <package>\`.`,
    });
  }
  if (candidates.length > 1) {
    throw new CoreError("AMBIGUOUS_TOOL", `"${ref.name}" matches several installed packages.`, {
      details: candidates,
      hint: `Use the full name, e.g. \`splice run ${candidates[0]}.${ref.tool}\`.`,
    });
  }
  const id = candidates[0]!;
  try {
    const pkg = await loadPackage(project.packageDir(id));
    await assertInstalledIntact(project, id, lock.packages[id]);
    return { pkg, tool: ref.tool };
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw new CoreError("INVALID_PACKAGE", `Installed package ${id} is missing or invalid.`, {
        details: error.details,
        hint: `Reinstall it with \`splice add ${id}\`.`,
      });
    }
    throw error;
  }
}
