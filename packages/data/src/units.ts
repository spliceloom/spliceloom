/** Exact numeric helpers (BigInt; no floating point for on-chain amounts). */

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const HASH = /^0x[0-9a-fA-F]{64}$/;

export function hexToBigInt(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error(`not a hex quantity: ${hex}`);
  return hex === "0x" ? 0n : BigInt(hex);
}

export const hexToDecimal = (hex: string): string => hexToBigInt(hex).toString();

export const toHexQuantity = (value: bigint | number): string => `0x${BigInt(value).toString(16)}`;

/** Formats an integer amount with `decimals` places, exactly (trailing zeros trimmed). */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** ABI-decodes a dynamic `string` return value, or a bytes32 string (older tokens). */
export function decodeAbiString(hex: string): string | null {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (data.length === 64) {
    const bytes = Buffer.from(data, "hex");
    const end = bytes.indexOf(0);
    const text = bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
    return /^[\x20-\x7e]*$/.test(text) && text.length > 0 ? text : null;
  }
  if (data.length < 128) return null;
  const offset = Number(BigInt(`0x${data.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${data.slice(offset, offset + 64)}`)) * 2;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset + 64 + length > data.length) return null;
  return Buffer.from(data.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
}

/** Address in the low 20 bytes of a 32-byte storage word, or null for zero. */
export function addressFromWord(word: string): string | null {
  const hex = word.replace(/^0x/, "").padStart(64, "0").slice(24);
  return /^0+$/.test(hex) ? null : `0x${hex}`;
}
