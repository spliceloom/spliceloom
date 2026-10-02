/**
 * GitHub developer data (read-only): the official REST API (api.github.com) with GITHUB_TOKEN
 * ("github") and anonymously ("github-public"), plus public raw files from
 * raw.githubusercontent.com ("github-raw"). Requests go through the Splice network guard with a
 * per-provider host allowlist; the token is sent only to api.github.com and never returned.
 *
 * GitHub errors are mapped precisely (401 bad credentials vs. "requires authentication", 403 rate
 * limit vs. forbidden, 404, 409, 422) and are never turned into empty results; an empty list is
 * returned only when GitHub itself returned one.
 */
import type { Scope } from "../chains.js";
import { rateLimitFrom, type HttpClient } from "../http.js";
import type { ProviderCapability, ProviderData, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

const API = "https://api.github.com";
export const DEFAULT_GITHUB_API_VERSION = "2022-11-28";

const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
type Raw = Record<string, any>;
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  /** From GitHub's Link header. */
  nextPage?: number;
  lastPage?: number;
  /** Search endpoints only. */
  totalCount?: number;
  incompleteResults?: boolean;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
}

export function normalizeRepo(r: Raw) {
  return prune({
    fullName: String(r.full_name),
    owner: str(r.owner?.login),
    name: str(r.name),
    description: str(r.description),
    private: bool(r.private),
    fork: bool(r.fork),
    archived: bool(r.archived),
    defaultBranch: str(r.default_branch),
    language: str(r.language),
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : undefined,
    stars: num(r.stargazers_count),
    forks: num(r.forks_count),
    openIssues: num(r.open_issues_count),
    watchers: num(r.subscribers_count),
    license: str(r.license?.spdx_id),
    homepage: str(r.homepage),
    sizeKb: num(r.size),
    url: str(r.html_url),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    pushedAt: str(r.pushed_at),
  });
}

function normalizeRelease(r: Raw) {
  return prune({
    id: num(r.id),
    tag: str(r.tag_name),
    name: str(r.name),
    draft: bool(r.draft),
    prerelease: bool(r.prerelease),
    author: str(r.author?.login),
    createdAt: str(r.created_at),
    publishedAt: str(r.published_at),
    url: str(r.html_url),
    body: str(r.body),
    assets: Array.isArray(r.assets) ? r.assets.map((a: Raw) => prune({ name: str(a.name), size: num(a.size), downloadCount: num(a.download_count), contentType: str(a.content_type), url: str(a.browser_download_url) })) : undefined,
  });
}

/** Decodes base64 file content; binary files (NUL bytes) are not returned as text. */
function decodeContent(item: Raw): { content?: string; binary?: boolean } {
  if (item.encoding !== "base64" || typeof item.content !== "string") return {};
  const bytes = Buffer.from(item.content.replace(/\n/g, ""), "base64");
  if (bytes.includes(0)) return { binary: true };
  return { content: bytes.toString("utf8") };
}

function pageOf(link: string | null): { nextPage?: number; lastPage?: number } {
  const out: { nextPage?: number; lastPage?: number } = {};
  for (const part of (link ?? "").split(",")) {
    const m = /<([^>]+)>;\s*rel="(next|last)"/.exec(part);
    if (!m) continue;
    const page = Number(new URL(m[1]!).searchParams.get("page"));
    if (Number.isInteger(page)) out[m[2] === "next" ? "nextPage" : "lastPage"] = page;
  }
  return out;
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const GITHUB_CAPABILITIES: ProviderCapability[] = [
  "developer.repository",
  "developer.repository_search",
  "developer.repository_contents",
  "developer.repository_tree",
  "developer.commits",
  "developer.branches",
  "developer.releases",
  "developer.issues",
  "developer.pull_requests",
  "developer.user",
  "developer.code_search",
];

export class GitHubProvider {
  readonly name: string;
  readonly kind: ProviderKind = "developer";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[];
  readonly auth: string;
  readonly envVars: string[];
  readonly endpoint = API;
  readonly rateLimit: string;
  readonly docs = "https://docs.github.com/en/rest";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null;
  private readonly authenticated: boolean;

  constructor(
    private readonly http: HttpClient,
    private readonly token: string | undefined,
    private readonly apiVersion: string,
    mode: "token" | "public",
  ) {
    this.authenticated = mode === "token";
    this.name = mode === "token" ? "github" : "github-public";
    this.unconfigured = mode === "token" && !token ? "GITHUB_TOKEN is not set" : null;
    this.auth = mode === "token" ? "Bearer token (GITHUB_TOKEN)" : "none (anonymous public API)";
    this.envVars = mode === "token" ? ["GITHUB_TOKEN", "GITHUB_API_VERSION"] : ["GITHUB_API_VERSION"];
    this.rateLimit = mode === "token" ? "5,000 requests/hour (core), 30/min search, 10/min code search" : "60 requests/hour per IP (core), 10/min search; code search requires authentication";
    // Code search requires authentication (live: HTTP 401 "Requires authentication" anonymously).
    this.capabilities = mode === "token" ? GITHUB_CAPABILITIES : GITHUB_CAPABILITIES.filter((c) => c !== "developer.code_search");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": this.apiVersion };
    if (this.authenticated && this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private mapError = (status: number, headers: Headers, detail: string): ProviderError | undefined => {
    let message = detail;
    try {
      message = (JSON.parse(detail) as { message?: string }).message ?? detail;
    } catch {
      /* raw */
    }
    const text = `GitHub HTTP ${status}: ${message}`;
    if (status === 401) return this.authenticated ? new ProviderError(text, "auth", status) : new ProviderError(`${text} (this endpoint needs GITHUB_TOKEN)`, "rejected", status);
    if (status === 403 || status === 429) {
      const remaining = headers.get("x-ratelimit-remaining");
      if (status === 429 || remaining === "0" || /rate limit/i.test(message)) {
        const reset = Number(headers.get("x-ratelimit-reset") ?? "NaN");
        const retryAfter = Number(headers.get("retry-after") ?? "NaN");
        const wait = Number.isFinite(retryAfter) ? retryAfter : Number.isFinite(reset) ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : undefined;
        return new ProviderError(`${text}${Number.isFinite(reset) ? ` (resets ${new Date(reset * 1000).toISOString()})` : ""}`, "rate_limited", status, wait);
      }
      return new ProviderError(text, "rejected", status);
    }
    if (status === 404) return new ProviderError(text, "not_found", status);
    // 409 (e.g. empty repository), 422 (invalid query/parameters), 451 (blocked): this request as such.
    if (status === 409 || status === 422 || status === 451) return new ProviderError(text, "rejected", status);
    return new ProviderError(text, "http", status);
  };

  async get<T = Raw>(path: string, query: Record<string, string | number | undefined> = {}): Promise<{ body: T; headers: Headers; resource: string }> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.http.json<T>(url.toString(), { headers: this.headers() }, { mapError: this.mapError });
    return { body: res.body, headers: res.headers, resource: `${path.slice(1)}${url.search}` };
  }

  private data<T>(value: T, r: { headers: Headers; resource: string }, notes?: string[]): ProviderData<T> {
    const out: ProviderData<T> = { data: value, resource: r.resource };
    const rl = rateLimitFrom(r.headers);
    if (rl) out.rateLimit = rl;
    const id = r.headers.get("x-github-request-id");
    if (id) out.requestId = id;
    if (notes?.length) out.notes = notes;
    return out;
  }

  private page<T>(items: T[], r: { headers: Headers }, opts: ListOptions, extra: Partial<Page<T>> = {}): Page<T> {
    return prune({ items, page: opts.page ?? 1, perPage: opts.perPage ?? 30, ...pageOf(r.headers.get("link")), ...extra }) as Page<T>;
  }

  private q(opts: ListOptions) {
    return { page: opts.page, per_page: opts.perPage };
  }

  async repository(owner: string, repo: string) {
    const r = await this.get(`/repos/${owner}/${repo}`);
    return this.data(normalizeRepo(r.body), r);
  }

  async searchRepositories(query: string, opts: ListOptions & { sort?: string; order?: string } = {}) {
    const r = await this.get<Raw>("/search/repositories", { q: query, sort: opts.sort, order: opts.order, ...this.q(opts) });
    return this.data(this.page((r.body.items ?? []).map(normalizeRepo), r, opts, { totalCount: num(r.body.total_count), incompleteResults: bool(r.body.incomplete_results) }), r);
  }

  async contents(owner: string, repo: string, path: string, ref?: string) {
    const r = await this.get<Raw | Raw[]>(`/repos/${owner}/${repo}/contents/${enc(path)}`, { ref });
    const repository = `${owner}/${repo}`;
    if (Array.isArray(r.body)) {
      const entries = r.body.map((e) => prune({ name: str(e.name), path: str(e.path), type: str(e.type), size: num(e.size), sha: str(e.sha), url: str(e.html_url) }));
      return this.data(prune({ repository, path, ref, type: "directory", entries }), r);
    }
    const item = r.body;
    const decoded = decodeContent(item);
    const notes: string[] = [];
    if (decoded.binary) notes.push("binary file: content is not returned as text");
    if (item.type === "file" && item.encoding === "none") notes.push("file is larger than the contents API returns inline (1 MB); use raw content or the git blob API");
    return this.data(
      prune({ repository, path: str(item.path) ?? path, ref, type: str(item.type), size: num(item.size), sha: str(item.sha), url: str(item.html_url), downloadUrl: str(item.download_url), target: str(item.target), content: decoded.content }),
      r,
      notes,
    );
  }

  async tree(owner: string, repo: string, ref: string | undefined, recursive: boolean) {
    let treeish = ref;
    if (!treeish) {
      const repoInfo = await this.get(`/repos/${owner}/${repo}`);
      treeish = String(repoInfo.body.default_branch);
    }
    const r = await this.get<Raw>(`/repos/${owner}/${repo}/git/trees/${enc(treeish)}`, { recursive: recursive ? 1 : undefined });
    const entries = (r.body.tree ?? []).map((e: Raw) => prune({ path: str(e.path), type: str(e.type), size: num(e.size), sha: str(e.sha) }));
    return this.data(prune({ repository: `${owner}/${repo}`, ref: treeish, sha: str(r.body.sha), truncated: bool(r.body.truncated), entries }), r, r.body.truncated ? ["GitHub truncated this tree (too many entries); list subdirectories separately"] : undefined);
  }

  async commits(owner: string, repo: string, opts: ListOptions & { ref?: string; path?: string } = {}) {
    const r = await this.get<Raw[]>(`/repos/${owner}/${repo}/commits`, { sha: opts.ref, path: opts.path, ...this.q(opts) });
    const items = r.body.map((c) =>
      prune({
        sha: str(c.sha),
        message: str(c.commit?.message),
        author: prune({ name: str(c.commit?.author?.name), login: str(c.author?.login), date: str(c.commit?.author?.date) }),
        committer: prune({ name: str(c.commit?.committer?.name), login: str(c.committer?.login), date: str(c.commit?.committer?.date) }),
        parents: Array.isArray(c.parents) ? c.parents.length : undefined,
        url: str(c.html_url),
      }),
    );
    return this.data(this.page(items, r, opts), r);
  }

  async branches(owner: string, repo: string, opts: ListOptions = {}) {
    const r = await this.get<Raw[]>(`/repos/${owner}/${repo}/branches`, this.q(opts));
    return this.data(this.page(r.body.map((b) => prune({ name: str(b.name), sha: str(b.commit?.sha), protected: bool(b.protected) })), r, opts), r);
  }

  async releases(owner: string, repo: string, opts: ListOptions = {}) {
    const r = await this.get<Raw[]>(`/repos/${owner}/${repo}/releases`, this.q(opts));
    return this.data(this.page(r.body.map(normalizeRelease), r, opts), r);
  }

  /** `which`: "latest", a tag, or a numeric release id. */
  async release(owner: string, repo: string, which: string) {
    const path = which === "latest" ? `/repos/${owner}/${repo}/releases/latest` : /^\d+$/.test(which) ? `/repos/${owner}/${repo}/releases/${which}` : `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(which)}`;
    const r = await this.get(path);
    return this.data(normalizeRelease(r.body), r);
  }

  async issues(owner: string, repo: string, opts: ListOptions & { state?: string } = {}) {
    const r = await this.get<Raw[]>(`/repos/${owner}/${repo}/issues`, { state: opts.state, ...this.q(opts) });
    // GitHub's issues endpoint also returns pull requests; they are removed (and counted) here.
    const issues = r.body.filter((i) => !i.pull_request);
    const items = issues.map((i) =>
      prune({ number: num(i.number), title: str(i.title), state: str(i.state), author: str(i.user?.login), labels: Array.isArray(i.labels) ? i.labels.map((l: Raw) => String(l.name)) : undefined, comments: num(i.comments), createdAt: str(i.created_at), updatedAt: str(i.updated_at), closedAt: str(i.closed_at), url: str(i.html_url) }),
    );
    const removed = r.body.length - issues.length;
    return this.data(this.page(items, r, opts), r, removed ? [`${removed} pull request(s) on this page were removed (GitHub lists them as issues); use pull requests for those`] : undefined);
  }

  async pullRequests(owner: string, repo: string, opts: ListOptions & { state?: string } = {}) {
    const r = await this.get<Raw[]>(`/repos/${owner}/${repo}/pulls`, { state: opts.state, ...this.q(opts) });
    const items = r.body.map((p) =>
      prune({ number: num(p.number), title: str(p.title), state: str(p.state), draft: bool(p.draft), author: str(p.user?.login), head: str(p.head?.ref), base: str(p.base?.ref), createdAt: str(p.created_at), updatedAt: str(p.updated_at), mergedAt: str(p.merged_at), url: str(p.html_url) }),
    );
    return this.data(this.page(items, r, opts), r);
  }

  /** The authenticated user (no login; needs the token) or a public user by login. */
  async user(login?: string) {
    if (!login && !this.authenticated) throw new ProviderError("the authenticated user needs a valid GITHUB_TOKEN; pass a login for a public profile", "rejected");
    const r = await this.get(login ? `/users/${login}` : "/user");
    const u = r.body;
    return this.data(
      prune({ login: String(u.login), id: num(u.id), type: str(u.type), name: str(u.name), company: str(u.company), blog: str(u.blog), location: str(u.location), bio: str(u.bio), publicRepos: num(u.public_repos), followers: num(u.followers), following: num(u.following), createdAt: str(u.created_at), url: str(u.html_url) }),
      r,
    );
  }

  async searchCode(query: string, opts: ListOptions = {}) {
    const r = await this.get<Raw>("/search/code", { q: query, ...this.q(opts) });
    const items = (r.body.items ?? []).map((i: Raw) => prune({ name: str(i.name), path: str(i.path), sha: str(i.sha), repository: str(i.repository?.full_name), url: str(i.html_url) }));
    return this.data(this.page(items, r, opts, { totalCount: num(r.body.total_count), incompleteResults: bool(r.body.incomplete_results) }), r);
  }

  /** Lightweight: /user with a token (proves it), /rate_limit anonymously (does not consume quota). */
  async check(_scope: Scope): Promise<{ detail: string }> {
    if (this.authenticated) {
      const r = await this.get("/user");
      const rl = rateLimitFrom(r.headers);
      return { detail: `token accepted (user ${r.body.login})${rl?.remaining !== undefined ? `; core rate limit ${rl.remaining}/${rl.limit}` : ""}` };
    }
    const r = await this.get<Raw>("/rate_limit");
    const core = r.body.resources?.core;
    return { detail: `public API reachable; core rate limit ${core?.remaining}/${core?.limit} for this IP` };
  }
}

// ---------------------------------------------------------------------------------- raw content

const RAW_HOST = "raw.githubusercontent.com";

export interface RawLocation {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

/**
 * Parses and validates a raw GitHub URL. Only https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 * is accepted: no other host, port, credentials, query, fragment, traversal or encoded separators.
 */
export function parseRawUrl(input: string): RawLocation | string {
  if (input.length > 2048) return "URL too long";
  if (/%2e|%2f|%5c|\\/i.test(input)) return "encoded path separators, dots and backslashes are not allowed";
  if (/\/\.\.?(\/|$)/.test(input.replace(/^https:\/\//, ""))) return "path traversal is not allowed";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "only https URLs are allowed";
  if (url.hostname !== RAW_HOST) return `only ${RAW_HOST} URLs are allowed (got ${url.hostname})`;
  if (url.port || url.username || url.password) return "ports and credentials are not allowed";
  if (url.search || url.hash) return "query strings and fragments are not allowed";
  const segments = url.pathname.split("/").slice(1);
  if (segments.length < 4 || segments.some((s) => s === "")) return "expected https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}";
  let refParts = 1;
  if (segments[2] === "refs" && (segments[3] === "heads" || segments[3] === "tags") && segments.length >= 6) refParts = 3;
  const [owner, repo] = segments;
  return { owner: owner!, repo: repo!, ref: segments.slice(2, 2 + refParts).join("/"), path: segments.slice(2 + refParts).join("/") };
}

export const rawUrl = (l: RawLocation) => `https://${RAW_HOST}/${l.owner}/${l.repo}/${l.ref.split("/").map(encodeURIComponent).join("/")}/${enc(l.path)}`;

export class GitHubRawProvider {
  readonly name = "github-raw";
  readonly kind: ProviderKind = "developer";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["developer.raw_content"];
  readonly auth = "none (public files only; the GitHub token is never sent here)";
  readonly envVars: string[] = [];
  readonly endpoint = `https://${RAW_HOST}/{owner}/{repo}/{ref}/{path}`;
  readonly rateLimit = "Not documented; abusive request rates are throttled by GitHub";
  readonly docs = "https://docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null = null;

  constructor(private readonly http: HttpClient) {}

  async file(location: RawLocation, maxBytes: number): Promise<ProviderData<Record<string, unknown>>> {
    const url = rawUrl(location);
    const res = await this.http.text(url, {}, {
      maxBytes,
      mapError: (status, _h, detail) => (status === 404 ? new ProviderError(`raw.githubusercontent.com HTTP 404: ${location.owner}/${location.repo}@${location.ref}:${location.path} not found (or private)`, "not_found", 404) : status === 429 ? new ProviderError(`raw.githubusercontent.com HTTP 429: ${detail}`, "rate_limited", 429) : undefined),
    });
    const binary = res.body.includes("\u0000");
    const data = prune({ url, ...location, size: Buffer.byteLength(res.body, "utf8"), contentType: res.headers.get("content-type") ?? undefined, etag: res.headers.get("etag") ?? undefined, content: binary ? undefined : res.body });
    const out: ProviderData<Record<string, unknown>> = { data, resource: url.slice(`https://${RAW_HOST}/`.length) };
    if (binary) out.notes = ["binary file: content is not returned as text"];
    const id = res.headers.get("x-github-request-id");
    if (id) out.requestId = id;
    return out;
  }

  /** Lightweight HEAD-sized check against a small, long-lived public file. */
  async check(_scope: Scope): Promise<{ detail: string }> {
    const res = await this.http.text(`https://${RAW_HOST}/github/gitignore/main/Node.gitignore`, {}, { maxBytes: 64 * 1024 });
    return { detail: `reachable (${res.body.length} bytes from github/gitignore)` };
  }
}
