/** Token generation and hashing with Web Crypto only (runs in Workers and Node.js). */
import { TOKEN_PREFIX } from "@spliceloom/spec";

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new user token: `splice_` + 256 random bits (base64url). */
export function generateToken(): string {
  return TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * SHA-256 (hex) of a token. Tokens carry 256 bits of randomness, so a fast hash is sufficient:
 * brute-forcing the hash is as hard as guessing the token. Only this value is stored.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for equal-length hex digests. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extracts the bearer token from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
