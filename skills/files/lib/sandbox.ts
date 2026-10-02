/**
 * Path policy of @splice/files. Every path is relative to the package's sandbox directory
 * `<project>/workspace` — the only directory this package declares in permissions.fs, so the
 * Node.js permission model already refuses everything else. This module adds the checks the
 * permission model does not do:
 *
 * - clear errors for absolute paths, `..`, backslashes, NUL bytes and over-long paths;
 * - symlinks: Node's permission model follows symlinks out of allowed directories, so every
 *   existing path is resolved with realpath and must stay inside the (real) workspace;
 * - credential-like names (.env, private keys, SSH/AWS/npm/git credentials, …) are refused even
 *   inside the workspace and hidden from listings;
 * - Windows semantics, refused on every platform: reserved device names, trailing dots/spaces,
 *   ":" (alternate data streams), 8.3 short-name aliases; junctions are links like symlinks;
 * - files are verified again through the opened descriptor (single hard link, same file as the
 *   in-workspace real path) before they are read or modified.
 *
 * Residual limitation: an attacker who can modify the workspace *concurrently* (another process)
 * could still race a path swap between the final check and the open of a *new* file. Node has no
 * portable O_NOFOLLOW/openat; see docs/permissions.md.
 */
import { lstat, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const WORKSPACE_DIR = "workspace";
export const MAX_PATH_LENGTH = 512;

export interface Context {
  paths: { project: string };
}

export function fail(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

const SENSITIVE: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(ssh|gnupg|aws|azure|kube|docker)$/i,
  /^\.(npmrc|yarnrc|netrc|pgpass|git-credentials|pypirc)$/i,
  /^credentials(\.[a-z]+)?$/i,
  /^\.?secrets?(\.[a-z]+)?$/i,
];

/** True when a single path segment looks like a credential or secret store. */
export function isSensitiveName(segment: string): boolean {
  return SENSITIVE.some((re) => re.test(segment));
}

/**
 * Names that are unsafe on Windows, refused on every platform so behaviour is the same everywhere
 * (fail closed):
 * - reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, CONIN$, CONOUT$, with any extension);
 * - trailing dots/spaces, which Windows strips (".env." would open ".env");
 * - ":" (NTFS alternate data streams, drive-relative paths) and characters Windows forbids;
 * - 8.3 short-name aliases ("SECRET~1.YAM" may point at "secrets.yaml");
 * - control characters.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
export function windowsUnsafeReason(segment: string): string | null {
  if (/[\u0000-\u001f]/.test(segment)) return "contains control characters";
  if (/[<>:"|?*]/.test(segment)) return 'contains a character that is not allowed in file names (< > : " | ? *)';
  if (/[. ]$/.test(segment)) return "ends with a dot or space (Windows would strip it)";
  if (WINDOWS_RESERVED.test(segment)) return "is a reserved device name";
  if (/~\d/.test(segment)) return "looks like an 8.3 short-name alias";
  return null;
}

/** The workspace root (real path). */
export async function workspaceRoot(ctx: Context): Promise<string> {
  return realpath(join(ctx.paths.project, WORKSPACE_DIR));
}

/**
 * Validates a workspace-relative path and returns its absolute form plus its segments.
 * `allowRoot` lets "." (or "") refer to the workspace itself (used by list).
 */
export function resolveSandboxPath(root: string, input: string, allowRoot = false): { abs: string; segments: string[]; display: string } {
  if (input.length > MAX_PATH_LENGTH) throw fail("INVALID_PATH", `path is longer than ${MAX_PATH_LENGTH} characters`);
  if (input.includes("\0")) throw fail("INVALID_PATH", "path contains a NUL byte");
  if (input.includes("\\")) throw fail("INVALID_PATH", 'use "/" as the path separator');
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input) || input.startsWith("~")) {
    throw fail("PATH_OUTSIDE_SANDBOX", `"${input}" is absolute; paths are relative to the ${WORKSPACE_DIR}/ sandbox`);
  }
  const trimmed = input.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") {
    if (!allowRoot) throw fail("INVALID_PATH", "a file path is required");
    return { abs: root, segments: [], display: "." };
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "..") throw fail("PATH_OUTSIDE_SANDBOX", `"${input}" escapes the ${WORKSPACE_DIR}/ sandbox`);
    if (segment === "" || segment === ".") throw fail("INVALID_PATH", `"${input}" contains an empty or "." segment`);
    // Checked before the name rules below: ".env." must not slip past the ".env" rule.
    const unsafe = windowsUnsafeReason(segment);
    if (unsafe) throw fail("INVALID_PATH", `"${input}": segment "${segment}" ${unsafe}`);
    if (isSensitiveName(segment)) throw fail("SENSITIVE_PATH", `"${input}" looks like a credential or secret file and cannot be accessed`);
  }
  return { abs: join(root, ...segments), segments, display: segments.join("/") };
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuses paths whose existing part resolves (through symlinks) outside the workspace. */
export async function assertRealPathInside(root: string, abs: string): Promise<void> {
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(root, real)) throw fail("PATH_OUTSIDE_SANDBOX", "path resolves outside the sandbox (symbolic link)");
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" && probe !== root) {
        probe = join(probe, "..");
        continue;
      }
      if (code === "ERR_ACCESS_DENIED") throw fail("PATH_OUTSIDE_SANDBOX", "path resolves outside the sandbox");
      throw error;
    }
  }
}

/**
 * After opening a file: the descriptor must be the regular, single-link file that the path
 * resolves to inside the workspace. Catches hard links to files elsewhere (a hard link has no
 * "outside" path to detect, so any file with more than one link is refused) and a path swapped
 * for a link between the checks and the open.
 */
export async function assertOpenedInside(root: string, abs: string, handle: FileHandle, display: string): Promise<void> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) throw fail("NOT_A_FILE", `"${display}" is not a regular file`);
  if (opened.nlink > 1n) throw fail("HARD_LINK", `"${display}" has ${opened.nlink} hard links; files with several links are refused because they can alias files outside the sandbox`);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" changed while it was being opened`);
  }
  if (!inside(root, real)) throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" resolves outside the sandbox`);
  const current = await lstat(real, { bigint: true });
  if (current.ino !== opened.ino || current.dev !== opened.dev) throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" changed while it was being opened`);
}

/** lstat that returns null for missing paths. */
export async function lstatOrNull(abs: string) {
  try {
    return await lstat(abs);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}
