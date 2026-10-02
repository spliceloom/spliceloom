interface PickInput {
  value: unknown;
  paths: string[];
}

interface PickResult {
  path: string;
  found: boolean;
  value?: unknown;
}

interface PickOutput {
  results: PickResult[];
  missing: string[];
}

type Segment = string | number;

function invalid(path: string, why: string): Error {
  return new Error(`INVALID_PATH: "${path}": ${why}`);
}

/**
 * Parses `a.b[0]["key.with.dots"]`. A leading `$` (or `$.`) refers to the whole value.
 * Dot segments may contain any character except `.`, `[` and `]`.
 */
export function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  if (path === "$") return segments;
  if (path.startsWith("$.") || path.startsWith("$[")) i = path[1] === "." ? 2 : 1;
  let expectSegment = path[i] !== "[";
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === "[") {
      if (path[i + 1] === '"') {
        let j = i + 2;
        while (j < path.length && path[j] !== '"') j += path[j] === "\\" ? 2 : 1;
        if (path[j] !== '"' || path[j + 1] !== "]") throw invalid(path, `unterminated ["..."] at ${i}`);
        try {
          segments.push(JSON.parse(path.slice(i + 1, j + 1)) as string);
        } catch {
          throw invalid(path, `invalid quoted key at ${i}`);
        }
        i = j + 2;
      } else {
        const close = path.indexOf("]", i);
        const index = close === -1 ? "" : path.slice(i + 1, close);
        if (!/^(0|[1-9]\d{0,8})$/.test(index)) throw invalid(path, `expected [index] or ["key"] at ${i}`);
        segments.push(Number(index));
        i = close + 1;
      }
      expectSegment = false;
    } else if (ch === "." && !expectSegment) {
      i++;
      expectSegment = true;
    } else if (expectSegment) {
      let j = i;
      while (j < path.length && !".[]".includes(path[j]!)) j++;
      if (j === i) throw invalid(path, `empty segment at ${i}`);
      segments.push(path.slice(i, j));
      i = j;
      expectSegment = false;
    } else {
      throw invalid(path, `unexpected "${ch}" at ${i}`);
    }
  }
  if (expectSegment && path.length > 0) throw invalid(path, "ends with '.'");
  return segments;
}

/** Own properties only: never reads through the prototype chain. */
function step(current: unknown, segment: Segment): { found: boolean; value?: unknown } {
  if (typeof segment === "number") {
    return Array.isArray(current) && segment < current.length ? { found: true, value: current[segment] } : { found: false };
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, segment)) {
    return { found: true, value: (current as Record<string, unknown>)[segment] };
  }
  return { found: false };
}

export default function pick(input: PickInput): PickOutput {
  const results: PickResult[] = [];
  const missing: string[] = [];
  for (const path of input.paths) {
    let current: unknown = input.value;
    let found = true;
    for (const segment of parsePath(path)) {
      const next = step(current, segment);
      if (!next.found) {
        found = false;
        break;
      }
      current = next.value;
    }
    if (found) results.push({ path, found: true, value: current });
    else {
      results.push({ path, found: false });
      missing.push(path);
    }
  }
  return { results, missing };
}
