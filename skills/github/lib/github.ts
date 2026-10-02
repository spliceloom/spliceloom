/**
 * Minimal read-only client for the public GitHub REST API (https://api.github.com).
 *
 * No authentication: requests are anonymous, so GitHub allows about 60 requests per hour per IP
 * and only public data is visible. The package declares no environment variables, so a token
 * could not be passed even if one were available — by design for this first version.
 */

export const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

export function fail(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function checkOwner(owner: string): string {
  if (!OWNER.test(owner)) throw fail("INVALID_INPUT", `"${owner}" is not a valid GitHub user or organization name`);
  return owner;
}

export function checkRepo(repo: string): string {
  if (!REPO.test(repo) || repo === "." || repo === "..") throw fail("INVALID_INPUT", `"${repo}" is not a valid repository name`);
  return repo;
}

export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface Repository {
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  url: string;
  homepage: string | null;
  defaultBranch: string;
  language: string | null;
  license: string | null;
  topics: string[];
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  fork: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toRepository(raw: Raw): Repository {
  const owner = (raw.owner ?? {}) as Raw;
  const license = (raw.license ?? null) as Raw | null;
  return {
    fullName: String(raw.full_name ?? ""),
    name: String(raw.name ?? ""),
    owner: String(owner.login ?? ""),
    description: str(raw.description),
    url: String(raw.html_url ?? ""),
    homepage: str(raw.homepage) || null,
    defaultBranch: String(raw.default_branch ?? ""),
    language: str(raw.language),
    license: license ? str(license.spdx_id) : null,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t): t is string => typeof t === "string") : [],
    stars: num(raw.stargazers_count),
    forks: num(raw.forks_count),
    openIssues: num(raw.open_issues_count),
    archived: raw.archived === true,
    fork: raw.fork === true,
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    pushedAt: str(raw.pushed_at),
  };
}

function rateLimit(headers: Headers): RateLimit {
  const n = (name: string) => {
    const v = headers.get(name);
    return v === null || !/^\d+$/.test(v) ? null : Number(v);
  };
  const reset = n("x-ratelimit-reset");
  return { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetAt: reset === null ? null : new Date(reset * 1000).toISOString() };
}

/** GET a GitHub API path (always on api.github.com) and return the parsed JSON plus rate-limit info. */
export async function apiGet(path: string, query: Record<string, string | number> = {}): Promise<{ data: unknown; rateLimit: RateLimit }> {
  const url = new URL(path, API);
  if (url.origin !== API) throw fail("INVALID_INPUT", "invalid API path");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  let response: Response;
  let text: string;
  try {
    response = await fetch(url.href, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "splice-github/0.1.0 (+https://spliceloom.io)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw fail("RESPONSE_TOO_LARGE", `GitHub response is ${declared} bytes`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw fail("RESPONSE_TOO_LARGE", `GitHub response is ${bytes.byteLength} bytes`);
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string; cause?: { message?: string } };
    if (err?.code === "ERR_ACCESS_DENIED") throw error;
    if (typeof err?.message === "string" && /^[A-Z_]+: /.test(err.message)) throw error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw fail("TIMEOUT", `GitHub did not respond within ${TIMEOUT_MS} ms`);
    throw fail("NETWORK_ERROR", `could not reach GitHub: ${err?.message ?? String(error)}${err?.cause?.message ? ` (${err.cause.message})` : ""}`);
  }

  const limits = rateLimit(response.headers);
  let data: unknown;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw fail("GITHUB_ERROR", `GitHub returned invalid JSON (HTTP ${response.status})`);
  }
  if (response.ok) return { data, rateLimit: limits };

  const message = typeof (data as Raw | null)?.message === "string" ? String((data as Raw).message) : `HTTP ${response.status}`;
  if (response.status === 404) throw fail("NOT_FOUND", message === "Not Found" ? "not found (or not public)" : message);
  if ((response.status === 403 || response.status === 429) && limits.remaining === 0) {
    throw fail("RATE_LIMITED", `the anonymous GitHub API limit (${limits.limit ?? 60} requests/hour) is used up; resets at ${limits.resetAt ?? "unknown"}`);
  }
  if (response.status === 422) throw fail("INVALID_INPUT", `GitHub rejected the request: ${message}`);
  throw fail("GITHUB_ERROR", `GitHub returned HTTP ${response.status}: ${message}`);
}
