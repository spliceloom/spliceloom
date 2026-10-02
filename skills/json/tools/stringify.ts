interface StringifyInput {
  value: unknown;
  indent?: number;
  sortKeys?: boolean;
}

interface StringifyOutput {
  text: string;
  bytes: number;
}

/** Recursively sorts object keys (arrays keep their order). Keys are compared by UTF-16 code units. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      // defineProperty: a "__proto__" key stays a plain data property.
      Object.defineProperty(out, key, { value: sortKeysDeep((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

export default function stringify(input: StringifyInput): StringifyOutput {
  const value = input.sortKeys ? sortKeysDeep(input.value) : input.value;
  const text = JSON.stringify(value, null, input.indent ?? 0);
  return { text, bytes: new TextEncoder().encode(text).byteLength };
}
