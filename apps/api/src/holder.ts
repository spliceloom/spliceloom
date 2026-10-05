/**
 * $SPLICE holder access: a wallet proves ownership by signing a short message (EIP-191
 * `personal_sign`; no transaction, no approval, no gas). The server recovers the signer, reads its
 * $SPLICE balance from the chain, and issues a 24-hour pass (HMAC-signed, stateless).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

/** Minimum balance for holder access, in whole tokens. */
export const HOLDER_MIN_TOKENS = 100_000;
export const HOLDER_PASS_MS = 24 * 3_600_000;
const SIGN_WINDOW_MS = 10 * 60_000;

const enc = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));

/** The exact text the wallet signs. */
export function holderMessage(address: string, issuedAt: string): string {
  return `Splice holder access\n\nSign to prove you own this wallet. This is not a transaction and costs no gas.\n\nAddress: ${address.toLowerCase()}\nIssued: ${issuedAt}`;
}

/** Recovers the address that signed `message` with personal_sign; null when the signature is malformed. */
export function recoverSigner(message: string, signature: string): string | null {
  const sig = signature.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  const body = enc.encode(message);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...body]));
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const point = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest);
    const pub = point.toRawBytes(false).slice(1);
    return `0x${hex(keccak_256(pub).slice(-20))}`;
  } catch {
    return null;
  }
}

/** Checks a signed holder message: fresh, well-formed and signed by the address it names. */
export function verifyHolderSignature(input: { address: string; issuedAt: string; signature: string }, now: number): { ok: true; address: string } | { ok: false; reason: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) return { ok: false, reason: "invalid address" };
  const issued = Date.parse(input.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > SIGN_WINDOW_MS) return { ok: false, reason: "the signed message is too old; sign again" };
  const signer = recoverSigner(holderMessage(input.address, input.issuedAt), input.signature);
  if (!signer || signer !== input.address.toLowerCase()) return { ok: false, reason: "the signature does not match this wallet" };
  return { ok: true, address: signer };
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

/** A stateless pass: `<address>.<expiry ms>.<hmac>`. */
export async function issuePass(secret: string, address: string, now: number): Promise<{ pass: string; expiresAt: number }> {
  const expiresAt = now + HOLDER_PASS_MS;
  const body = `${address.toLowerCase()}.${expiresAt}`;
  return { pass: `${body}.${await hmac(secret, body)}`, expiresAt };
}

export async function readPass(secret: string, pass: string, now: number): Promise<string | null> {
  const m = /^(0x[0-9a-f]{40})\.(\d{13})\.([0-9a-f]{64})$/.exec(pass);
  if (!m || Number(m[2]) < now) return null;
  const expected = fromHex(await hmac(secret, `${m[1]}.${m[2]}`));
  const given = fromHex(m[3]!);
  let diff = expected.length ^ given.length;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ (given[i] ?? 0);
  return diff === 0 ? m[1]! : null;
}

/**
 * A code that ties a wallet verification to one Telegram chat: `<chat id>.<hmac>`. The bot hands it
 * out; only a chat id the bot produced a code for can be linked, so nobody can link someone else's
 * chat by guessing ids.
 */
export async function telegramLinkCode(secret: string, chatId: string): Promise<string> {
  return `${chatId}.${(await hmac(secret, `tg-link:${chatId}`)).slice(0, 32)}`;
}

export async function readTelegramLinkCode(secret: string, code: string): Promise<string | null> {
  const m = /^(-?\d{1,20})\.([0-9a-f]{32})$/.exec(code);
  if (!m) return null;
  const expected = (await hmac(secret, `tg-link:${m[1]}`)).slice(0, 32);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? m[1]! : null;
}
