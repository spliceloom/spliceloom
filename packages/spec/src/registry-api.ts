/**
 * Registry HTTP API v2 — shared between the registry server and the CLI client.
 *
 *   GET  /health                                          → HealthResponse
 *   GET  /packages/search?q=<query>&limit=<n>             → SearchResponse
 *   GET  /packages/:namespace/:name                       → PackageResponse
 *   GET  /packages/:namespace/:name/versions              → VersionsResponse
 *   GET  /packages/:namespace/:name/:version              → VersionResponse
 *   GET  /packages/:namespace/:name/:version/download     → bundle bytes
 *   GET  /packages/:namespace/:name/:version/provenance   → ProvenanceResponse
 *   POST /publish                         (user token)    → PublishResponse
 *   GET  /auth/whoami                     (user token)    → WhoamiResponse
 *   GET/POST /auth/tokens, DELETE /auth/tokens/:id  (managing token) → token management
 *   GET  /namespaces/:ns                                  → NamespaceResponse
 *   PUT/DELETE /namespaces/:ns/maintainers/:user  (owner) → NamespaceResponse
 *
 * Admin endpoints (admin token) are documented in docs/registry.md.
 * Errors are returned as ApiErrorBody with a matching HTTP status.
 */
import type { Manifest } from "./manifest.js";
import { parsePackageId } from "./names.js";

export const REGISTRY_API_VERSION = 2;

/** Response header carrying the artifact integrity on downloads. */
export const INTEGRITY_HEADER = "x-splice-integrity";
/** Content type of a Splice bundle. */
export const BUNDLE_CONTENT_TYPE = "application/vnd.splice.bundle+json";
/** Prefix of registry user tokens; makes leaked tokens easy to detect by secret scanners. */
export const TOKEN_PREFIX = "splice_";

export interface HealthResponse {
  status: "ok";
  apiVersion: number;
}

export interface SearchResult {
  name: string;
  description: string;
  latest: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface PackageVersionSummary {
  version: string;
  publishedAt: string;
}

export interface PackageResponse {
  name: string;
  namespace: string;
  description: string;
  latest: string;
  versions: PackageVersionSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface VersionsResponse {
  name: string;
  versions: Array<PackageVersionSummary & { integrity: string; size: number }>;
}

export interface VersionResponse {
  name: string;
  version: string;
  manifest: Manifest;
  integrity: string;
  size: number;
  publishedAt: string;
  publishedBy: string;
  /** Path (relative to the registry base URL) of the artifact download. */
  download: string;
  /**
   * Where the artifact is stored. `url` is a direct public URL when the backend has one (GitHub
   * release asset). Clients must verify `integrity` whichever URL they download from.
   */
  artifact?: { filename: string; backend: string | null; url: string | null };
  /** Provenance (Phase 5+ registries). */
  provenance?: ProvenanceRecord;
}

/**
 * Where a version came from, recorded at publish time. Contains facts only (no trust score).
 * `recorded: false` marks versions published before provenance existed; their record is derived
 * from the registry's metadata columns.
 */
export interface ProvenanceRecord {
  schemaVersion: 1;
  recorded: boolean;
  /** Registry API version that accepted the publish (null when derived). */
  registryApiVersion: number | null;
  package: string;
  version: string;
  namespace: string;
  publisher: { user: string; via: "token" | "internal" | "unknown" };
  publishedAt: string;
  artifact: {
    integrity: string;
    size: number;
    format: "tar.gz" | "json-bundle";
    filename: string;
  };
  /** SHA-256 (hex) of the canonical JSON of the validated manifest (null when derived). */
  manifestSha256: string | null;
}

export interface ProvenanceResponse {
  name: string;
  version: string;
  provenance: ProvenanceRecord;
  /** Current storage location (may change without changing the artifact's identity). */
  location: { backend: string | null; url: string | null };
}

export interface PublishResponse {
  name: string;
  version: string;
  integrity: string;
  size: number;
  download: string;
}

/** Metadata about a token. Never contains the token or its hash. */
export interface TokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** null = every namespace the user may publish to. */
  namespaces: string[] | null;
  /** Whether the token may manage tokens and namespace maintainers. */
  canManage: boolean;
}

export interface WhoamiResponse {
  user: string;
  /** Namespaces the user may publish to (owned or maintained). */
  namespaces: string[];
  owns: string[];
  maintains: string[];
  /** The token used for this request. */
  token: TokenInfo;
}

export interface TokenListResponse {
  tokens: Array<TokenInfo & { current: boolean }>;
}

export interface CreatedTokenResponse extends TokenInfo {
  /** The token itself. Returned only once, at creation. */
  token: string;
  user: string;
}

export interface NamespaceResponse {
  namespace: string;
  owner: string | null;
  maintainers: string[];
  reserved: boolean;
  packages: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: string[] };
}

export function packagePath(id: string): string {
  const { namespace, name } = parsePackageId(id);
  return `/packages/${namespace}/${name}`;
}

export function versionsPath(id: string): string {
  return `${packagePath(id)}/versions`;
}

export function versionPath(id: string, version: string): string {
  return `${packagePath(id)}/${encodeURIComponent(version)}`;
}

export function downloadPath(id: string, version: string): string {
  return `${versionPath(id, version)}/download`;
}

export function provenancePath(id: string, version: string): string {
  return `${versionPath(id, version)}/provenance`;
}

export function searchPath(query: string, limit: number): string {
  return `/packages/search?${new URLSearchParams({ q: query, limit: String(limit) })}`;
}

export const PUBLISH_PATH = "/publish";
export const WHOAMI_PATH = "/auth/whoami";
export const TOKENS_PATH = "/auth/tokens";

export function tokenPath(id: string): string {
  return `${TOKENS_PATH}/${encodeURIComponent(id)}`;
}

export function namespacePath(namespace: string): string {
  return `/namespaces/${encodeURIComponent(namespace)}`;
}

export function maintainerPath(namespace: string, user: string): string {
  return `${namespacePath(namespace)}/maintainers/${encodeURIComponent(user)}`;
}

/** Maximum lifetime of a token created through the API, in days. */
export const MAX_TOKEN_DAYS = 365;
