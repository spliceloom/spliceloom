/**
 * Package verification: a pipeline of small verifiers, run before anything is extracted.
 *
 *   sha256    artifact bytes hash to the integrity recorded in the registry
 *   size      artifact length equals the recorded size
 *   package   the archive decodes safely and is a valid package whose manifest names the expected
 *             package and version
 *   metadata  the manifest inside the artifact equals the manifest the registry serves
 *   signature signing policy — today no signatures exist, so this reports "unsigned"; a future
 *             SignatureVerifier plugs in here without changing callers
 *
 * Checks run in order and stop at the first failure (later checks are "skipped"), so untrusted
 * bytes are never decoded after a hash mismatch. Uses Web APIs only (Node.js and Workers).
 *
 * SHA-256 proves the bytes are the ones the registry recorded. It is NOT a signature and does not
 * prove who authored the package.
 */
import { decodePackageArchive } from "./archive.js";
import { INTEGRITY_PATTERN, computeIntegrity, validateBundleFiles, type BundleFile } from "./bundle.js";
import { manifestId, validateManifest, type Manifest } from "./manifest.js";

export type CheckStatus = "passed" | "failed" | "skipped";

export interface VerificationCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

/** A detached signature over an artifact. Reserved: no signatures are produced or accepted yet. */
export interface PackageSignature {
  /** e.g. "ed25519", "sigstore". */
  algorithm: string;
  keyId: string;
  /** Base64 signature value. */
  value: string;
}

/** What the registry says the artifact is. */
export interface ExpectedArtifact {
  id: string;
  version: string;
  integrity: string;
  size?: number;
  manifest?: Manifest;
  signatures?: PackageSignature[];
}

export interface VerificationInput {
  bytes: Uint8Array;
  expected: ExpectedArtifact;
}

/** State shared by verifiers (the package verifier fills in the decoded files and manifest). */
export interface VerificationState {
  files?: BundleFile[];
  manifest?: Manifest;
}

export interface PackageVerifier {
  readonly id: string;
  verify(input: VerificationInput, state: VerificationState): Promise<VerificationCheck>;
}

export interface VerificationResult {
  verified: boolean;
  checks: VerificationCheck[];
  /** Present when verification passed: the validated files and manifest, ready to install. */
  files?: BundleFile[];
  manifest?: Manifest;
}

const pass = (id: string, message: string): VerificationCheck => ({ id, status: "passed", message });
const fail = (id: string, message: string): VerificationCheck => ({ id, status: "failed", message });

/** Stable JSON (sorted object keys) for comparing manifests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class Sha256Verifier implements PackageVerifier {
  readonly id = "sha256";
  async verify({ bytes, expected }: VerificationInput): Promise<VerificationCheck> {
    if (!INTEGRITY_PATTERN.test(expected.integrity)) return fail(this.id, `registry integrity "${expected.integrity}" is not a sha256 digest`);
    const actual = await computeIntegrity(bytes);
    return actual === expected.integrity ? pass(this.id, `artifact SHA-256 matches ${actual}`) : fail(this.id, `artifact SHA-256 ${actual} does not match expected ${expected.integrity}`);
  }
}

export class SizeVerifier implements PackageVerifier {
  readonly id = "size";
  async verify({ bytes, expected }: VerificationInput): Promise<VerificationCheck> {
    if (expected.size === undefined) return { id: this.id, status: "skipped", message: "registry did not report a size" };
    return bytes.byteLength === expected.size
      ? pass(this.id, `artifact size ${bytes.byteLength} bytes matches`)
      : fail(this.id, `artifact is ${bytes.byteLength} bytes, registry recorded ${expected.size}`);
  }
}

export class PackageContentVerifier implements PackageVerifier {
  readonly id = "package";
  async verify({ bytes, expected }: VerificationInput, state: VerificationState): Promise<VerificationCheck> {
    let files: BundleFile[];
    try {
      files = await decodePackageArchive(bytes);
    } catch (error) {
      return fail(this.id, `archive rejected: ${(error as Error).message}`);
    }
    const validation = validateBundleFiles(files);
    if (!validation.ok) return fail(this.id, `invalid package: ${validation.errors.join("; ")}`);
    const manifest = validation.value;
    if (manifestId(manifest) !== expected.id || manifest.version !== expected.version) {
      return fail(this.id, `artifact contains ${manifestId(manifest)}@${manifest.version}, expected ${expected.id}@${expected.version}`);
    }
    state.files = files;
    state.manifest = manifest;
    return pass(this.id, `valid package ${expected.id}@${expected.version} (${files.length} files)`);
  }
}

export class MetadataVerifier implements PackageVerifier {
  readonly id = "metadata";
  async verify({ expected }: VerificationInput, state: VerificationState): Promise<VerificationCheck> {
    if (!expected.manifest) return { id: this.id, status: "skipped", message: "registry did not provide a manifest" };
    if (!state.manifest) return fail(this.id, "artifact manifest unavailable");
    const served = validateManifest(expected.manifest);
    if (!served.ok) return fail(this.id, `registry manifest is invalid: ${served.errors.join("; ")}`);
    return canonicalJson(served.value) === canonicalJson(state.manifest)
      ? pass(this.id, "registry metadata matches the manifest inside the artifact")
      : fail(this.id, "registry metadata does not match the manifest inside the artifact");
  }
}

/**
 * Signing policy. Splice does not sign packages yet: unsigned artifacts are accepted and reported
 * as such. Signatures that cannot be verified fail closed (never silently ignored).
 */
export class SignaturePolicyVerifier implements PackageVerifier {
  readonly id = "signature";
  async verify({ expected }: VerificationInput): Promise<VerificationCheck> {
    if (!expected.signatures || expected.signatures.length === 0) {
      return { id: this.id, status: "skipped", message: "unsigned: package signing is not implemented yet (integrity is SHA-256 only)" };
    }
    return fail(this.id, `unsupported signature algorithm(s): ${expected.signatures.map((s) => s.algorithm).join(", ")}`);
  }
}

/**
 * Digest of a package's *extracted* files (format independent: the same for a .tar.gz and a
 * legacy JSON bundle with the same contents). Recorded in splice.lock at install and re-checked
 * before installed code is loaded, so files modified on disk are never executed.
 * Definition: SHA-256 over lines `path \0 sha256hex(content) \n`, sorted by path.
 */
export async function filesDigest(files: ReadonlyArray<{ path: string; content: Uint8Array }>): Promise<string> {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    lines.push(`${file.path}\0${(await computeIntegrity(file.content)).slice("sha256-".length)}\n`);
  }
  return computeIntegrity(encoder.encode(lines.join("")));
}

export function defaultVerifiers(): PackageVerifier[] {
  return [new Sha256Verifier(), new SizeVerifier(), new PackageContentVerifier(), new MetadataVerifier(), new SignaturePolicyVerifier()];
}

export async function verifyArtifact(input: VerificationInput, verifiers: PackageVerifier[] = defaultVerifiers()): Promise<VerificationResult> {
  const state: VerificationState = {};
  const checks: VerificationCheck[] = [];
  let failed = false;
  for (const verifier of verifiers) {
    if (failed) {
      checks.push({ id: verifier.id, status: "skipped", message: "not run: an earlier check failed" });
      continue;
    }
    const check = await verifier.verify(input, state);
    checks.push(check);
    if (check.status === "failed") failed = true;
  }
  const result: VerificationResult = { verified: !failed, checks };
  if (!failed && state.files && state.manifest) {
    result.files = state.files;
    result.manifest = state.manifest;
  }
  return result;
}
