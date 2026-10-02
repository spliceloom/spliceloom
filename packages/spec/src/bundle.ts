/**
 * Splice bundle v1: the artifact format stored by the registry and downloaded by the CLI.
 *
 * A bundle is UTF-8 JSON:
 *   { "format": "splice-bundle", "formatVersion": 1,
 *     "files": [{ "path": "manifest.json", "content": "<base64>" }, ...] }
 *
 * Files are sorted by path so the same package contents always produce the same bytes
 * and therefore the same integrity hash. Uses only Web platform APIs so it runs in
 * Node.js and in Cloudflare Workers alike.
 */
import { SpecError, type ValidationResult } from "./errors.js";
import { MANIFEST_FILE, SKILL_DOC_FILE, parseManifest, type Manifest } from "./manifest.js";
import { isSafeRelativePath } from "./permissions.js";

export const BUNDLE_FORMAT = "splice-bundle";
export const BUNDLE_FORMAT_VERSION = 1;
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 500;

export interface BundleFile {
  /** Package-relative path using forward slashes. */
  path: string;
  content: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isSafeBundlePath(path: string): boolean {
  return path !== "." && isSafeRelativePath(path);
}

/** Serializes files into deterministic bundle bytes. */
export function encodeBundle(files: readonly BundleFile[]): Uint8Array {
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeBundlePath(file.path)) throw new SpecError("INVALID_BUNDLE", `Unsafe file path in bundle: "${file.path}"`);
    if (seen.has(file.path)) throw new SpecError("INVALID_BUNDLE", `Duplicate file path in bundle: "${file.path}"`);
    seen.add(file.path);
  }
  if (files.length > MAX_BUNDLE_FILES) {
    throw new SpecError("INVALID_BUNDLE", `Bundle has ${files.length} files (max ${MAX_BUNDLE_FILES})`);
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const json = JSON.stringify({
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    files: sorted.map((f) => ({ path: f.path, content: toBase64(f.content) })),
  });
  const bytes = encoder.encode(json);
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new SpecError("INVALID_BUNDLE", `Bundle is ${bytes.byteLength} bytes (max ${MAX_BUNDLE_BYTES})`);
  }
  return bytes;
}

/** Parses untrusted bundle bytes. Throws SpecError when the bundle is malformed or unsafe. */
export function decodeBundle(bytes: Uint8Array): BundleFile[] {
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new SpecError("INVALID_BUNDLE", `Bundle is ${bytes.byteLength} bytes (max ${MAX_BUNDLE_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new SpecError("INVALID_BUNDLE", "Bundle is not valid UTF-8 JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new SpecError("INVALID_BUNDLE", "Bundle must be an object");
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== BUNDLE_FORMAT) throw new SpecError("INVALID_BUNDLE", "Not a Splice bundle");
  if (obj.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new SpecError("INVALID_BUNDLE", `Unsupported bundle formatVersion ${JSON.stringify(obj.formatVersion)}`);
  }
  if (!Array.isArray(obj.files) || obj.files.length > MAX_BUNDLE_FILES) {
    throw new SpecError("INVALID_BUNDLE", "Bundle files must be an array of at most " + MAX_BUNDLE_FILES);
  }
  const seen = new Set<string>();
  return obj.files.map((entry, i) => {
    const file = entry as Record<string, unknown> | null;
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new SpecError("INVALID_BUNDLE", `Bundle file #${i} is malformed`);
    }
    if (!isSafeBundlePath(file.path)) throw new SpecError("INVALID_BUNDLE", `Unsafe file path in bundle: "${file.path}"`);
    // Reject case-insensitive duplicates too: they would collide on Windows/macOS file systems.
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new SpecError("INVALID_BUNDLE", `Duplicate file path in bundle: "${file.path}"`);
    seen.add(key);
    try {
      return { path: file.path, content: fromBase64(file.content) };
    } catch {
      throw new SpecError("INVALID_BUNDLE", `Bundle file "${file.path}" has invalid base64 content`);
    }
  });
}

/** Integrity string for artifact bytes: `sha256-<hex>`. */
export async function computeIntegrity(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256-${hex}`;
}

export const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;

/**
 * Checks that bundle files form a valid package: a valid manifest.json, a SKILL.md and
 * an existing file for every tool entry.
 */
export function validateBundleFiles(files: readonly BundleFile[]): ValidationResult<Manifest> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifestFile = byPath.get(MANIFEST_FILE);
  if (!manifestFile) return { ok: false, errors: [`${MANIFEST_FILE} is missing`] };
  let text: string;
  try {
    text = decoder.decode(manifestFile.content);
  } catch {
    return { ok: false, errors: [`${MANIFEST_FILE} is not valid UTF-8`] };
  }
  const result = parseManifest(text);
  if (!result.ok) return result;
  const errors: string[] = [];

  // No file may bypass validation: hidden files (.env, .git, …) and node_modules are never part of a package.
  for (const file of files) {
    if (file.path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")) {
      errors.push(`disallowed file "${file.path}": hidden files and node_modules are not allowed in packages`);
    }
    if (file.content.byteLength > MAX_FILE_BYTES) errors.push(`file "${file.path}" exceeds ${MAX_FILE_BYTES} bytes`);
  }

  const doc = byPath.get(SKILL_DOC_FILE);
  if (!doc) {
    errors.push(`${SKILL_DOC_FILE} is missing`);
  } else {
    errors.push(...validateSkillDoc(doc.content));
  }
  for (const tool of result.value.tools) {
    if (!byPath.has(tool.entry)) errors.push(`tool "${tool.name}": entry file "${tool.entry}" is missing`);
  }
  return errors.length > 0 ? { ok: false, errors } : result;
}

export const MAX_SKILL_DOC_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** SKILL.md must be non-empty UTF-8 text without NUL bytes, at most 256 KiB. */
export function validateSkillDoc(content: Uint8Array): string[] {
  if (content.byteLength > MAX_SKILL_DOC_BYTES) return [`${SKILL_DOC_FILE} exceeds ${MAX_SKILL_DOC_BYTES} bytes`];
  let text: string;
  try {
    text = decoder.decode(content);
  } catch {
    return [`${SKILL_DOC_FILE} is not valid UTF-8`];
  }
  if (text.includes("\0")) return [`${SKILL_DOC_FILE} must be text (contains NUL bytes)`];
  if (text.trim().length === 0) return [`${SKILL_DOC_FILE} is empty`];
  return [];
}
