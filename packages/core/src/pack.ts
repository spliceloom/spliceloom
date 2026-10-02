import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  MAX_BUNDLE_FILES,
  computeIntegrity,
  encodeTarGz,
  filesDigest,
  validateBundleFiles,
  type BundleFile,
  type Manifest,
} from "@spliceloom/spec";
import { CoreError } from "./errors.js";

const IGNORED = new Set(["node_modules"]);

export interface PackResult {
  manifest: Manifest;
  files: BundleFile[];
  bytes: Uint8Array;
  integrity: string;
}

async function collect(root: string, dir: string, out: BundleFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Hidden files (.git, .env, .DS_Store, ...) are never packed.
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      throw new CoreError("INVALID_PACKAGE", `Symbolic links are not allowed in packages: ${relative(root, full)}`);
    }
    if (info.isDirectory()) {
      await collect(root, full, out);
    } else if (info.isFile()) {
      if (out.length >= MAX_BUNDLE_FILES) throw new CoreError("INVALID_PACKAGE", `Package has more than ${MAX_BUNDLE_FILES} files`);
      out.push({ path: relative(root, full).split(sep).join("/"), content: new Uint8Array(await readFile(full)) });
    }
  }
}

/**
 * Digest (`filesDigest`) of an installed package directory, counting *every* file — hidden ones
 * and node_modules included, since a verified artifact contains neither — so any file added,
 * removed or changed after installation changes the digest. Symbolic links and non-regular files
 * make the directory invalid (returns null).
 */
export async function installedFilesDigest(dir: string): Promise<string | null> {
  const files: BundleFile[] = [];
  const walk = async (current: string): Promise<boolean> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isDirectory()) {
        if (!(await walk(full))) return false;
      } else if (info.isFile()) {
        if (files.length >= MAX_BUNDLE_FILES) return false;
        files.push({ path: relative(dir, full).split(sep).join("/"), content: new Uint8Array(await readFile(full)) });
      } else {
        return false;
      }
    }
    return true;
  };
  try {
    return (await walk(dir)) ? await filesDigest(files) : null;
  } catch {
    return null;
  }
}

/** Packs a skill directory into a validated, deterministic `.tar.gz` artifact (used by `splice publish`). */
export async function packDirectory(dir: string): Promise<PackResult> {
  const files: BundleFile[] = [];
  try {
    await collect(dir, dir, files);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_PACKAGE", `Cannot read package directory ${dir}: ${(error as Error).message}`);
  }
  const result = validateBundleFiles(files);
  if (!result.ok) throw new CoreError("INVALID_PACKAGE", `Package in ${dir} is invalid`, { details: result.errors });
  let bytes: Uint8Array;
  try {
    bytes = encodeTarGz(files);
  } catch (error) {
    throw new CoreError("INVALID_PACKAGE", (error as Error).message);
  }
  return { manifest: result.value, files, bytes, integrity: await computeIntegrity(bytes) };
}
