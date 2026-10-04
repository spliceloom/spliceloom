/**
 * Cloudflare Worker entry point: the registry handler backed by D1 (metadata) and an artifact
 * store — GitHub Releases in production; R2 or Workers KV when configured instead.
 * Deployed with `wrangler deploy` using apps/registry/wrangler.toml. R2 is NOT required.
 */
import { GitHubReleaseArtifactStore } from "./github.js";
import { createRegistryHandler } from "./handler.js";
import { githubIdentity } from "./signup.js";
import { sqlRateLimits, type RateLimitConfig, type RateLimiter, type RateLimits } from "./ratelimit.js";
import { RegistryService } from "./service.js";
import type { ArtifactStore, SqlDatabase, SqlStatement, SqlValue } from "./storage.js";

// Minimal structural types for the bindings we use (avoids a dependency on @cloudflare/workers-types).
interface D1Meta {
  rows_read?: number;
  rows_written?: number;
}

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T>(): Promise<{ results: T[]; meta?: D1Meta }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta?: D1Meta } | unknown>;
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/** Rows D1 reports as read/written while serving one request (what the daily quota counts). */
export interface D1Usage {
  rowsRead: number;
  rowsWritten: number;
}

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { sha256?: string; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

interface KVNamespaceLike {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: Uint8Array, options?: { metadata?: Record<string, string> }): Promise<void>;
}

export interface Env {
  DB: D1DatabaseLike;
  /** GitHub Releases artifact backend (production): vars GITHUB_OWNER / GITHUB_REPO, secret GITHUB_TOKEN. */
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  GITHUB_TAG_PREFIX?: string;
  /** Test/GHES overrides for the GitHub API endpoints. */
  GITHUB_API_URL?: string;
  GITHUB_UPLOAD_URL?: string;
  /** Optional R2 bucket for artifacts (not used in production). */
  ARTIFACTS?: R2BucketLike;
  /** Optional Workers KV namespace for artifacts (Phase 2 production store; kept for migration). */
  ARTIFACTS_KV?: KVNamespaceLike;
  /** Secret: SHA-256 (hex) of the admin token. */
  ADMIN_TOKEN_SHA256?: string;
  /** Cloudflare Rate Limiting bindings (wrangler.toml [[ratelimits]]): coarse, approximate limits. */
  AUTH_LIMITER?: RateLimitBindingLike;
  ADMIN_LIMITER?: RateLimitBindingLike;
  /** Optional overrides (wrangler.toml [vars]) for the database-backed limits. */
  PUBLISH_LIMIT_PER_MINUTE?: string;
  AUTH_FAILURES_PER_10_MINUTES?: string;
}

interface RateLimitBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

function bindingLimiter(binding: RateLimitBindingLike | undefined): RateLimiter | undefined {
  return binding ? { limit: async (key) => (await binding.limit({ key })).success } : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const n = value === undefined ? NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function rateLimitsFor(env: Env, db: SqlDatabase): RateLimits {
  const config: RateLimitConfig = {};
  const publish = positiveInt(env.PUBLISH_LIMIT_PER_MINUTE);
  const failures = positiveInt(env.AUTH_FAILURES_PER_10_MINUTES);
  if (publish) config.publishPerMinute = publish;
  if (failures) config.authFailuresPer10Minutes = failures;
  const limits: RateLimits = { ...sqlRateLimits(db, config) };
  const auth = bindingLimiter(env.AUTH_LIMITER);
  const admin = bindingLimiter(env.ADMIN_LIMITER);
  if (auth) limits.auth = auth;
  if (admin) limits.admin = admin;
  return limits;
}

export function d1Database(db: D1DatabaseLike, usage?: D1Usage): SqlDatabase {
  const prepare = (sql: string, params: SqlValue[] = []) => db.prepare(sql).bind(...params);
  const count = (result: unknown) => {
    const meta = (result as { meta?: D1Meta } | null)?.meta;
    if (!usage || !meta) return;
    usage.rowsRead += meta.rows_read ?? 0;
    usage.rowsWritten += meta.rows_written ?? 0;
  };
  return {
    async run(sql, params) {
      count(await prepare(sql, params).run());
    },
    async all<T>(sql: string, params?: SqlValue[]) {
      const result = await prepare(sql, params).all<T>();
      count(result);
      return result.results;
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      // `all()` (not `first()`) so D1's row counters are visible; the query itself is unchanged.
      const result = await prepare(sql, params).all<T>();
      count(result);
      return result.results[0] ?? null;
    },
    async batch(statements: SqlStatement[]) {
      for (const result of await db.batch(statements.map((s) => prepare(s.sql, s.params)))) count(result);
    },
  };
}

/**
 * Edge cache for anonymous, read-only registry data (Cloudflare Cache API, per data center).
 * Lists and package metadata change on publish: 60 s (purged right away in the data center that
 * handled the publish). Provenance is immutable: 1 day. Version metadata carries signatures, which can
 * be added later and whose keys can be revoked: 5 minutes. Artifact
 * downloads are not cached: the bytes come from storage and clients verify them, so a tampered
 * storage copy must stay detectable. Health, authenticated routes and errors are never cached.
 */
export function edgeCacheTtl(pathname: string): number | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "namespaces" && (segments.length === 2 || (segments.length === 3 && segments[2] === "keys"))) return 60;
  if (segments[0] !== "packages") return null;
  if (segments[1] === "search" && segments.length === 2) return 60;
  if (segments.length === 3) return 60; // package
  if (segments.length === 4) return segments[3] === "versions" ? 60 : 300; // version list | version metadata (signatures)
  if (segments.length === 5 && segments[4] === "provenance") return 86_400;
  return null;
}

/** Cached public paths a successful write makes stale (publish, maintainer or owner changes). */
export async function stalePaths(request: Request, response: Response): Promise<string[]> {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const namespacePaths = (ns: string) => [`/namespaces/${ns}`];
  if (segments[0] === "publish") {
    const body = (await response.clone().json().catch(() => null)) as { name?: string } | null;
    const m = /^@([^/]+)\/([^/]+)$/.exec(body?.name ?? "");
    return m ? [`/packages/${m[1]}/${m[2]}`, `/packages/${m[1]}/${m[2]}/versions`, ...namespacePaths(m[1]!)] : [];
  }
  if (segments[0] === "namespaces" && segments[2] === "maintainers" && segments[1]) return namespacePaths(segments[1]);
  if (segments[0] === "namespaces" && segments[2] === "keys" && segments[1]) return [`/namespaces/${segments[1]}/keys`];
  if (segments[0] === "packages" && segments[4] === "signatures" && segments.length === 5) return [`/packages/${segments[1]}/${segments[2]}/${segments[3]}`];
  if (segments[0] === "admin" && segments[1] === "namespaces" && segments[2]) return namespacePaths(segments[2]);
  return [];
}

// Not exported: workerd treats every named export of the entry module as an entrypoint.
const CACHE_STATUS_HEADER = "x-splice-cache";

export function r2ArtifactStore(bucket: R2BucketLike): ArtifactStore {
  return {
    backend: "r2",
    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async put(key, bytes, options) {
      // R2 verifies the SHA-256 server-side and rejects a corrupted upload.
      await bucket.put(key, bytes, { sha256: options.sha256, httpMetadata: { contentType: options.contentType } });
    },
  };
}

/**
 * Workers KV artifact store. Artifacts are immutable and content-addressed, so KV's eventual
 * consistency only matters for a few seconds right after a publish. Values are limited to 25 MiB
 * (bundles are limited to 5 MB). Clients verify the SHA-256 of every download.
 */
export function kvArtifactStore(kv: KVNamespaceLike): ArtifactStore {
  return {
    backend: "kv",
    async get(key) {
      const value = await kv.get(key, "arrayBuffer");
      return value ? new Uint8Array(value) : null;
    },
    async put(key, bytes, options) {
      await kv.put(key, bytes, { metadata: { sha256: options.sha256, contentType: options.contentType } });
    },
  };
}

function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_TOKEN);
}

/** Primary artifact store: GitHub Releases when configured, else R2, else KV. */
export function artifactStoreFor(env: Env): ArtifactStore {
  if (githubConfigured(env)) {
    const config: ConstructorParameters<typeof GitHubReleaseArtifactStore>[0] = {
      owner: env.GITHUB_OWNER!.trim(),
      repo: env.GITHUB_REPO!.trim(),
      // Secrets pasted via a shell may carry a trailing newline.
      token: env.GITHUB_TOKEN!.trim(),
    };
    if (env.GITHUB_TAG_PREFIX) config.tagPrefix = env.GITHUB_TAG_PREFIX;
    if (env.GITHUB_API_URL) config.apiUrl = env.GITHUB_API_URL;
    if (env.GITHUB_UPLOAD_URL) config.uploadUrl = env.GITHUB_UPLOAD_URL;
    return new GitHubReleaseArtifactStore(config);
  }
  if (env.ARTIFACTS) return r2ArtifactStore(env.ARTIFACTS);
  if (env.ARTIFACTS_KV) return kvArtifactStore(env.ARTIFACTS_KV);
  throw new Error("No artifact storage configured: set GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN, or bind ARTIFACTS (R2) or ARTIFACTS_KV (KV)");
}

/** Store holding artifacts from before the current primary store (only for `/admin/artifacts/migrate`). */
export function legacyArtifactStoreFor(env: Env): ArtifactStore | undefined {
  if (!githubConfigured(env)) return undefined;
  if (env.ARTIFACTS_KV) return kvArtifactStore(env.ARTIFACTS_KV);
  if (env.ARTIFACTS) return r2ArtifactStore(env.ARTIFACTS);
  return undefined;
}

/** Serves a request, using the edge cache for public reads and reporting D1 usage per response. */
export async function handleWorkerRequest(request: Request, env: Env, ctx?: ExecutionContextLike, cache?: CacheLike): Promise<Response> {
  const url = new URL(request.url);
  const ttl = request.method === "GET" && !request.headers.has("authorization") ? edgeCacheTtl(url.pathname) : null;
  const cacheKey = ttl !== null ? new Request(url.toString(), { method: "GET" }) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const response = new Response(hit.body, hit);
      response.headers.set(CACHE_STATUS_HEADER, "HIT");
      // A cached answer costs no database rows.
      response.headers.set("server-timing", 'd1;desc="rows_read=0 rows_written=0"');
      return response;
    }
  }

  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
  const db = d1Database(env.DB, usage);
  const service = new RegistryService(db, artifactStoreFor(env));
  const options: Parameters<typeof createRegistryHandler>[0] = { service, rateLimits: rateLimitsFor(env, db) };
  // Sign-up reads public GitHub data; the artifact token (when set) only raises the rate limit.
  options.identity = githubIdentity(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN.trim() } : {});
  const legacy = legacyArtifactStoreFor(env);
  if (legacy) options.legacyArtifacts = legacy;
  // Secrets pasted via a shell may carry a trailing newline.
  if (env.ADMIN_TOKEN_SHA256) options.adminTokenHash = env.ADMIN_TOKEN_SHA256.trim().toLowerCase();
  const response = await createRegistryHandler(options)(request);
  response.headers.set("server-timing", `d1;desc="rows_read=${usage.rowsRead} rows_written=${usage.rowsWritten}"`);

  if (cache && request.method !== "GET" && response.ok) {
    for (const path of await stalePaths(request, response)) await cache.delete(new Request(`${url.origin}${path}`, { method: "GET" }));
  }

  if (cacheKey && ttl !== null && response.status === 200) {
    response.headers.set("cache-control", `public, max-age=${ttl}${ttl >= 86_400 ? ", immutable" : ""}`);
    response.headers.set(CACHE_STATUS_HEADER, "MISS");
    if (cache) {
      const stored = cache.put(cacheKey, response.clone());
      if (ctx) ctx.waitUntil(stored);
      else await stored;
    }
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const cache = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    return handleWorkerRequest(request, env, ctx, cache);
  },
};
