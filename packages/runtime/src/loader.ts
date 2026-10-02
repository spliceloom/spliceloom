import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { MANIFEST_FILE, SKILL_DOC_FILE, manifestId, parseManifest, type Manifest } from "@spliceloom/spec";
import { RuntimeError } from "./errors.js";

export interface LoadedPackage {
  /** Canonical id, e.g. `@splice/example`. */
  id: string;
  /** Absolute, symlink-resolved package directory. */
  dir: string;
  manifest: Manifest;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Loads a package from a directory and validates it: manifest.json must satisfy the spec,
 * SKILL.md must exist, and every tool entry must be a real file inside the package
 * (symlinks pointing outside are rejected).
 */
export async function loadPackage(dir: string): Promise<LoadedPackage> {
  let root: string;
  try {
    root = await realpath(resolve(dir));
  } catch {
    throw new RuntimeError("INVALID_PACKAGE", `Package directory not found: ${dir}`);
  }

  let text: string;
  try {
    text = await readFile(join(root, MANIFEST_FILE), "utf8");
  } catch {
    throw new RuntimeError("INVALID_PACKAGE", `${MANIFEST_FILE} not found in ${root}`);
  }
  const result = parseManifest(text);
  if (!result.ok) {
    throw new RuntimeError("INVALID_PACKAGE", `Invalid ${MANIFEST_FILE} in ${root}`, result.errors);
  }
  const manifest = result.value;

  const problems: string[] = [];
  if (!(await isFile(join(root, SKILL_DOC_FILE)))) problems.push(`${SKILL_DOC_FILE} is missing`);
  for (const tool of manifest.tools) {
    const entry = join(root, tool.entry);
    let real: string;
    try {
      real = await realpath(entry);
    } catch {
      problems.push(`tool "${tool.name}": entry file "${tool.entry}" is missing`);
      continue;
    }
    if (!isInside(root, real)) problems.push(`tool "${tool.name}": entry resolves outside the package`);
    else if (!(await isFile(real))) problems.push(`tool "${tool.name}": entry "${tool.entry}" is not a file`);
  }
  if (problems.length > 0) {
    throw new RuntimeError("INVALID_PACKAGE", `Invalid package ${manifestId(manifest)}`, problems);
  }

  return { id: manifestId(manifest), dir: root, manifest };
}
