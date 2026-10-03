/**
 * Package signatures (Ed25519).
 *
 * A publisher signs the exact bytes of a published version: the payload names the package, the
 * version and the artifact's SHA-256 integrity, so a signature can never be moved to other bytes.
 * Public keys are registered per namespace in the registry; clients verify every signature locally.
 *
 * WebCrypto only (no Node.js APIs): the same code verifies in the CLI, the SDK and the registry Worker.
 */
import { INTEGRITY_PATTERN } from "./bundle.js";

export const SIGNATURE_SCHEME = "splice-package-signature-v1";

/** A registered public key: raw 32-byte Ed25519 key, base64. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
/** Ed25519 signature: 64 bytes, base64. */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
/** Key id: "ed25519:" + the first 16 hex characters of SHA-256(raw public key). */
export const KEY_ID_PATTERN = /^ed25519:[0-9a-f]{16}$/;

export interface PackageSignature {
  keyId: string;
  publicKey: string;
  signature: string;
  signedAt: string;
  /** Set when the namespace owner revoked the key; signatures by revoked keys are not trusted. */
  revokedAt: string | null;
}

export interface SigningKeyInfo {
  keyId: string;
  publicKey: string;
  namespace: string;
  addedBy: string;
  addedAt: string;
  revokedAt: string | null;
}

/** The exact text that is signed for `id@version` with `integrity`. */
export function signaturePayload(id: string, version: string, integrity: string): string {
  if (!INTEGRITY_PATTERN.test(integrity)) throw new Error(`invalid integrity: ${integrity}`);
  return `${SIGNATURE_SCHEME}\n${id}\n${version}\n${integrity}\n`;
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export { fromBase64 as decodeBase64, toBase64 as encodeBase64 };

export async function keyIdOf(publicKey: string): Promise<string> {
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) throw new Error("invalid Ed25519 public key (expected 32 bytes, base64)");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(publicKey) as Uint8Array<ArrayBuffer>));
  return `ed25519:${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** True when `signature` is a valid Ed25519 signature by `publicKey` over the payload for `id@version`. */
export async function verifyPackageSignature(input: { id: string; version: string; integrity: string; publicKey: string; signature: string }): Promise<boolean> {
  if (!PUBLIC_KEY_PATTERN.test(input.publicKey) || !SIGNATURE_PATTERN.test(input.signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64(input.publicKey) as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(signaturePayload(input.id, input.version, input.integrity));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(input.signature) as Uint8Array<ArrayBuffer>, data);
  } catch {
    return false;
  }
}

export type SignatureCheck =
  | { status: "verified"; keyId: string }
  | { status: "unsigned" }
  | { status: "invalid"; reason: string };

/**
 * Checks the signatures a registry returned for `id@version`. Any signature that does not verify,
 * or whose key id does not match its key, makes the result `invalid` (tampering). Signatures by
 * revoked keys are ignored. Otherwise the first valid signature wins.
 */
export async function checkSignatures(id: string, version: string, integrity: string, signatures: readonly PackageSignature[] | undefined): Promise<SignatureCheck> {
  let verified: string | undefined;
  for (const s of signatures ?? []) {
    if (s.revokedAt) continue;
    let keyId: string;
    try {
      keyId = await keyIdOf(s.publicKey);
    } catch {
      return { status: "invalid", reason: `signature ${s.keyId}: malformed public key` };
    }
    if (keyId !== s.keyId) return { status: "invalid", reason: `signature ${s.keyId}: key id does not match its public key` };
    if (!(await verifyPackageSignature({ id, version, integrity, publicKey: s.publicKey, signature: s.signature }))) {
      return { status: "invalid", reason: `signature by ${s.keyId} does not match ${id}@${version} (${integrity})` };
    }
    verified ??= keyId;
  }
  return verified ? { status: "verified", keyId: verified } : { status: "unsigned" };
}

