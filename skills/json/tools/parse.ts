interface ParseInput {
  text: string;
}

type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

interface ParseOutput {
  value: unknown;
  type: JsonType;
}

export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "object" | "string" | "number" | "boolean";
}

/**
 * Offset of the first syntax error in `text` (only called after JSON.parse failed). Iterative,
 * so deeply nested input cannot overflow the stack. Returns the text length for truncated input.
 */
export function syntaxErrorOffset(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else throw i;
  };
  const string = () => {
    i++; // opening quote
    for (;;) {
      if (i >= text.length) throw i;
      const c = text.charCodeAt(i);
      if (c === 0x22) return void i++;
      if (c < 0x20) throw i;
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw i;
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else throw i;
      } else i++;
    }
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) throw i;
    i += m[0].length;
  };
  // Stack of open containers; "k" = object expecting key, "v" = expecting value.
  const stack: Array<"{" | "["> = [];
  try {
    for (;;) {
      ws();
      // value
      const c = text[i];
      if (c === "{" || c === "[") {
        stack.push(c);
        i++;
        ws();
        if (text[i] === (c === "{" ? "}" : "]")) {
          i++;
          stack.pop();
        } else if (c === "{") {
          if (text[i] !== '"') throw i;
          string();
          ws();
          if (text[i] !== ":") throw i;
          i++;
          continue;
        } else continue;
      } else if (c === '"') string();
      else if (c === "t") literal("true");
      else if (c === "f") literal("false");
      else if (c === "n") literal("null");
      else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) number();
      else throw i;
      // after a value: close containers or continue with ","
      for (;;) {
        ws();
        const top = stack.at(-1);
        if (!top) {
          if (i < text.length) throw i;
          return text.length;
        }
        if (text[i] === (top === "{" ? "}" : "]")) {
          stack.pop();
          i++;
          continue;
        }
        if (text[i] !== ",") throw i;
        i++;
        ws();
        if (top === "{") {
          if (text[i] !== '"') throw i;
          string();
          ws();
          if (text[i] !== ":") throw i;
          i++;
        }
        break;
      }
    }
  } catch (offset) {
    if (typeof offset === "number") return Math.min(offset, text.length);
    throw offset;
  }
}

/** Maximum nesting of arrays/objects. Deeper documents are refused (also the Splice runtime's input limit). */
export const MAX_DEPTH = 256;

/** Nesting depth of JSON text (brackets outside strings), computed without parsing. */
export function textDepth(text: string, limit = MAX_DEPTH): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) max = depth;
      if (max > limit) return max;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return offset >= text.length ? `unexpected end of input (line ${line}, column ${column})` : `at position ${offset} (line ${line}, column ${column})`;
}

export default function parse(input: ParseInput): ParseOutput {
  if (textDepth(input.text) > MAX_DEPTH) throw new Error(`INVALID_JSON: nested deeper than ${MAX_DEPTH} levels`);
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch (error) {
    if (error instanceof RangeError) throw new Error("INVALID_JSON: nesting is too deep");
    throw new Error(`INVALID_JSON: ${position(input.text, syntaxErrorOffset(input.text))}: ${(error as Error).message}`);
  }
  return { value, type: jsonType(value) };
}
