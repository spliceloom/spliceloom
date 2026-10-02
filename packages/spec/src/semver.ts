/**
 * Minimal semantic versioning (https://semver.org) sufficient for Splice Phase 1.
 *
 * Supported ranges: exact `1.2.3`, caret `^1.2.3`, tilde `~1.2.3`, `*` and `latest`.
 * Prerelease versions only match an exact range.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseVersion(input: string): SemVer | null {
  const match = VERSION_PATTERN.exec(input);
  if (!match) return null;
  const nums = [match[1], match[2], match[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease };
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

function comparePrerelease(a: SemVer["prerelease"], b: SemVer["prerelease"]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareParsed(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Compares two versions. Throws on invalid input. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`Cannot compare invalid versions "${a}" and "${b}"`);
  return compareParsed(pa, pb);
}

export function isValidRange(range: string): boolean {
  if (range === "latest" || range === "*") return true;
  const base = range.startsWith("^") || range.startsWith("~") ? range.slice(1) : range;
  return isValidVersion(base);
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v || !isValidRange(range)) return false;
  if (range === "latest" || range === "*") return v.prerelease.length === 0;

  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const base = parseVersion(op ? range.slice(1) : range)!;
  if (!op) return compareParsed(v, base) === 0;
  if (v.prerelease.length > 0) return false;
  if (compareParsed(v, base) < 0) return false;

  if (op === "~") return v.major === base.major && v.minor === base.minor;
  // Caret: allow changes that do not modify the left-most non-zero component.
  if (base.major > 0) return v.major === base.major;
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
  return v.major === 0 && v.minor === 0 && v.patch === base.patch;
}

/** Highest version in `versions` satisfying `range`, or null. */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!satisfies(version, range)) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** Highest stable (non-prerelease) version, falling back to the highest prerelease. */
export function latestVersion(versions: readonly string[]): string | null {
  const stable = maxSatisfying(versions, "*");
  if (stable) return stable;
  const valid = versions.filter(isValidVersion);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}
