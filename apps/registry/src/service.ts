import {
  INTEGRITY_PATTERN,
  MAX_TOKEN_DAYS,
  NAME_SEGMENT_PATTERN,
  REGISTRY_API_VERSION,
  SpecError,
  TOKEN_PREFIX,
  computeIntegrity,
  ARCHIVE_CONTENT_TYPE,
  BUNDLE_CONTENT_TYPE,
  archiveFormat,
  decodePackageArchive,
  downloadPath,
  latestVersion,
  manifestId,
  parsePackageId,
  redactSecrets,
  validateBundleFiles,
  canonicalJson,
  type CreatedTokenResponse,
  type HealthResponse,
  type Manifest,
  type ProvenanceRecord,
  type ProvenanceResponse,
  type NamespaceResponse,
  type TokenInfo,
  type TokenListResponse,
  type PackageResponse,
  type PublishResponse,
  type SearchResponse,
  type VersionResponse,
  type VersionsResponse,
  type WhoamiResponse,
} from "@spliceloom/spec";
import { generateToken, hashToken } from "./auth.js";
import { ArtifactStoreError, isUniqueViolation, type ArtifactStore, type SqlDatabase, type StoredArtifact } from "./storage.js";

export type RegistryErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NAMESPACE_RESERVED"
  | "ADMIN_DISABLED"
  | "NOT_FOUND"
  | "VERSION_EXISTS"
  | "USER_EXISTS"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PACKAGE"
  | "TOKEN_SCOPE"
  | "RATE_LIMITED"
  | "ARTIFACT_STORAGE_FAILED"
  | "METADATA_WRITE_FAILED"
  | "DEPENDENCIES_UNSUPPORTED";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly status: number;
  readonly details: string[];

  /** Seconds, for 429 responses. */
  retryAfter: number | undefined;

  constructor(code: RegistryErrorCode, status: number, message: string, details: string[] = []) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface AuthUser {
  id: string;
  name: string;
  /** Present when authenticated with a token; absent for trusted internal callers (seed scripts). */
  token?: TokenInfo;
}

export interface TokenOptions {
  label?: string;
  namespaces?: string[] | null;
  expiresInDays?: number | null;
}

interface TokenRow {
  id: string;
  user_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  scope_namespaces: string | null;
  expires_at: string | null;
  can_manage: number;
}

function toTokenInfo(row: TokenRow): TokenInfo {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    namespaces: row.scope_namespaces ? row.scope_namespaces.split(",") : null,
    canManage: row.can_manage === 1,
  };
}

interface PackageRow {
  id: string;
  namespace: string;
  name: string;
  description: string;
  latest_version: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  package_id: string;
  version: string;
  manifest: string;
  integrity: string;
  size: number;
  artifact_key: string;
  artifact_backend: string | null;
  artifact_url: string | null;
  provenance: string | null;
  published_by: string;
  published_at: string;
}

interface NamespaceRow {
  name: string;
  owner_id: string | null;
  reserved: number;
}

/**
 * Deterministic, namespace-aware, version-specific object key. The content hash makes keys
 * collision-resistant: different bytes can never overwrite each other.
 */
export function artifactKey(
  namespace: string,
  name: string,
  version: string,
  integrity: string,
  extension: ".tar.gz" | ".bundle.json" = ".tar.gz",
): string {
  return `packages/${namespace}/${name}/${version}/${integrity.slice("sha256-".length)}${extension}`;
}

function artifactFilename(row: Pick<VersionRow, "package_id" | "version" | "artifact_key">): string {
  const { namespace, name } = parsePackageId(row.package_id);
  return `${namespace}-${name}-${row.version}${row.artifact_key.endsWith(".tar.gz") ? ".tar.gz" : ".splice.json"}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildProvenance(input: {
  id: string;
  manifest: Manifest;
  integrity: string;
  size: number;
  format: "tar.gz" | "json-bundle";
  publisher: string;
  publishedAt: string;
  via: "token" | "internal";
}): Promise<ProvenanceRecord> {
  const { namespace, name } = parsePackageId(input.id);
  return {
    schemaVersion: 1,
    recorded: true,
    registryApiVersion: REGISTRY_API_VERSION,
    package: input.id,
    version: input.manifest.version,
    namespace,
    publisher: { user: input.publisher, via: input.via },
    publishedAt: input.publishedAt,
    artifact: {
      integrity: input.integrity,
      size: input.size,
      format: input.format,
      filename: `${namespace}-${name}-${input.manifest.version}${input.format === "tar.gz" ? ".tar.gz" : ".splice.json"}`,
    },
    manifestSha256: await sha256Hex(canonicalJson(input.manifest)),
  };
}

/** Provenance for versions published before provenance was recorded, from the metadata columns. */
function derivedProvenance(row: VersionRow, publisher: string | undefined): ProvenanceRecord {
  const { namespace } = parsePackageId(row.package_id);
  return {
    schemaVersion: 1,
    recorded: false,
    registryApiVersion: null,
    package: row.package_id,
    version: row.version,
    namespace,
    publisher: { user: publisher ?? "unknown", via: "unknown" },
    publishedAt: row.published_at,
    artifact: {
      integrity: row.integrity,
      size: row.size,
      format: row.artifact_key.endsWith(".tar.gz") ? "tar.gz" : "json-bundle",
      filename: artifactFilename(row),
    },
    manifestSha256: null,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toPackageId(id: string): { id: string; namespace: string; name: string } {
  try {
    return parsePackageId(id);
  } catch (error) {
    throw new RegistryError("BAD_REQUEST", 400, (error as Error).message);
  }
}

function assertName(value: string, what: string): void {
  if (!NAME_SEGMENT_PATTERN.test(value)) {
    throw new RegistryError("BAD_REQUEST", 400, `Invalid ${what} "${value}": use lowercase letters, digits and dashes`);
  }
}

export class RegistryService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async close(): Promise<void> {
    await this.db.close?.();
  }

  health(): HealthResponse {
    return { status: "ok", apiVersion: REGISTRY_API_VERSION };
  }

  // ---------------------------------------------------------------- reading

  async search(query: string, limit = 20): Promise<SearchResponse> {
    const q = query.trim().toLowerCase().slice(0, 100);
    const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const pattern = `%${escapeLike(q)}%`;
    const rows = await this.db.all<PackageRow>(
      `SELECT * FROM packages
       WHERE id LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, id
       LIMIT ?`,
      [pattern, pattern, q, `${escapeLike(q)}%`, capped],
    );
    return { query: q, results: rows.map((r) => ({ name: r.id, description: r.description, latest: r.latest_version })) };
  }

  private async packageRow(idInput: string): Promise<PackageRow> {
    const { id } = toPackageId(idInput);
    const row = await this.db.first<PackageRow>("SELECT * FROM packages WHERE id = ?", [id]);
    if (!row) throw new RegistryError("NOT_FOUND", 404, `Package ${id} not found`);
    return row;
  }

  async getPackage(idInput: string): Promise<PackageResponse> {
    const row = await this.packageRow(idInput);
    const versions = await this.db.all<Pick<VersionRow, "version" | "published_at">>(
      "SELECT version, published_at FROM versions WHERE package_id = ? ORDER BY published_at, version",
      [row.id],
    );
    return {
      name: row.id,
      namespace: row.namespace,
      description: row.description,
      latest: row.latest_version,
      versions: versions.map((v) => ({ version: v.version, publishedAt: v.published_at })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listVersions(idInput: string): Promise<VersionsResponse> {
    const row = await this.packageRow(idInput);
    const versions = await this.db.all<Pick<VersionRow, "version" | "published_at" | "integrity" | "size">>(
      "SELECT version, published_at, integrity, size FROM versions WHERE package_id = ? ORDER BY published_at, version",
      [row.id],
    );
    return {
      name: row.id,
      versions: versions.map((v) => ({ version: v.version, publishedAt: v.published_at, integrity: v.integrity, size: v.size })),
    };
  }

  private async versionRow(idInput: string, version: string): Promise<VersionRow> {
    const { id } = toPackageId(idInput);
    const row = await this.db.first<VersionRow>("SELECT * FROM versions WHERE package_id = ? AND version = ?", [id, version]);
    if (!row) {
      const pkg = await this.db.first<{ id: string }>("SELECT id FROM packages WHERE id = ?", [id]);
      throw new RegistryError("NOT_FOUND", 404, pkg ? `Version ${id}@${version} not found` : `Package ${id} not found`);
    }
    return row;
  }

  async getVersion(idInput: string, version: string): Promise<VersionResponse> {
    const row = await this.versionRow(idInput, version);
    const publisher = await this.db.first<{ name: string }>("SELECT name FROM users WHERE id = ?", [row.published_by]);
    return {
      name: row.package_id,
      version: row.version,
      manifest: JSON.parse(row.manifest),
      integrity: row.integrity,
      size: row.size,
      publishedAt: row.published_at,
      publishedBy: publisher?.name ?? "unknown",
      download: downloadPath(row.package_id, row.version),
      artifact: { filename: artifactFilename(row), backend: row.artifact_backend, url: row.artifact_url },
      provenance: this.provenanceOf(row, publisher?.name),
    };
  }

  private provenanceOf(row: VersionRow, publisher: string | undefined): ProvenanceRecord {
    if (row.provenance) {
      try {
        return JSON.parse(row.provenance) as ProvenanceRecord;
      } catch {
        // fall through to derived
      }
    }
    return derivedProvenance(row, publisher);
  }

  async getProvenance(idInput: string, version: string): Promise<ProvenanceResponse> {
    const row = await this.versionRow(idInput, version);
    const publisher = await this.db.first<{ name: string }>("SELECT name FROM users WHERE id = ?", [row.published_by]);
    return {
      name: row.package_id,
      version: row.version,
      provenance: this.provenanceOf(row, publisher?.name),
      location: { backend: row.artifact_backend, url: row.artifact_url },
    };
  }

  async getArtifact(idInput: string, version: string): Promise<{ bytes: Uint8Array; integrity: string; filename: string }> {
    const row = await this.versionRow(idInput, version);
    let bytes: Uint8Array | null;
    try {
      bytes = await this.artifacts.get(row.artifact_key, row.artifact_url ? { url: row.artifact_url } : undefined);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw new RegistryError("ARTIFACT_STORAGE_FAILED", 502, `Artifact storage error: ${error.message}`);
      throw error;
    }
    if (!bytes) throw new RegistryError("NOT_FOUND", 404, `Artifact for ${row.package_id}@${row.version} is missing`);
    return { bytes, integrity: row.integrity, filename: artifactFilename(row) };
  }

  /**
   * Admin: copies artifacts that are not yet in the current backend (e.g. Phase 2 artifacts in KV)
   * from `legacy` into it, verifying each SHA-256, then records the new location.
   */
  async migrateArtifacts(legacy: ArtifactStore): Promise<{ migrated: string[]; skipped: string[] }> {
    const rows = await this.db.all<VersionRow>(
      "SELECT * FROM versions WHERE artifact_backend IS NULL OR artifact_backend != ? ORDER BY published_at",
      [this.artifacts.backend],
    );
    const migrated: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const label = `${row.package_id}@${row.version}`;
      const bytes = await legacy.get(row.artifact_key, row.artifact_url ? { url: row.artifact_url } : undefined);
      if (!bytes || (await computeIntegrity(bytes)) !== row.integrity) {
        skipped.push(label);
        continue;
      }
      const stored = await this.artifacts.put(row.artifact_key, bytes, {
        sha256: row.integrity.slice("sha256-".length),
        contentType: row.artifact_key.endsWith(".tar.gz") ? ARCHIVE_CONTENT_TYPE : BUNDLE_CONTENT_TYPE,
      });
      await this.db.run("UPDATE versions SET artifact_backend = ?, artifact_url = ? WHERE package_id = ? AND version = ?", [
        this.artifacts.backend,
        stored?.url ?? null,
        row.package_id,
        row.version,
      ]);
      migrated.push(label);
    }
    return { migrated, skipped };
  }

  // ---------------------------------------------------------------- auth

  /** Resolves a user token to its user, or null when unknown, revoked or expired. */
  async authenticate(token: string | null): Promise<AuthUser | null> {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const hash = await hashToken(token);
    const row = await this.db.first<TokenRow & { user_name: string }>(
      `SELECT t.*, u.name AS user_name
       FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      [hash],
    );
    if (!row) return null;
    const now = this.now().toISOString();
    if (row.expires_at !== null && row.expires_at <= now) return null;
    await this.db.run("UPDATE tokens SET last_used_at = ? WHERE id = ?", [now, row.id]);
    return { id: row.user_id, name: row.user_name, token: toTokenInfo({ ...row, last_used_at: now }) };
  }

  private async namespacesOf(userId: string): Promise<{ owns: string[]; maintains: string[] }> {
    const owns = await this.db.all<{ name: string }>("SELECT name FROM namespaces WHERE owner_id = ? ORDER BY name", [userId]);
    const maintains = await this.db.all<{ namespace: string }>(
      "SELECT namespace FROM namespace_maintainers WHERE user_id = ? ORDER BY namespace",
      [userId],
    );
    return { owns: owns.map((r) => r.name), maintains: maintains.map((r) => r.namespace) };
  }

  async whoami(user: AuthUser): Promise<WhoamiResponse> {
    if (!user.token) throw new Error("whoami requires a token-authenticated user");
    const { owns, maintains } = await this.namespacesOf(user.id);
    const namespaces = [...new Set([...owns, ...maintains])].sort();
    return { user: user.name, namespaces, owns, maintains, token: user.token };
  }

  // ---------------------------------------------------------------- self-service tokens

  private requireManage(user: AuthUser): void {
    if (user.token && !user.token.canManage) {
      throw new RegistryError("TOKEN_SCOPE", 403, "This token is publish-only and cannot manage tokens or maintainers");
    }
  }

  async listTokens(user: AuthUser): Promise<TokenListResponse> {
    this.requireManage(user);
    const rows = await this.db.all<TokenRow>("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at", [user.id]);
    return { tokens: rows.map((r) => ({ ...toTokenInfo(r), current: r.id === user.token?.id })) };
  }

  /** A user creates an extra, publish-only token for themselves (e.g. for CI). */
  async createUserToken(user: AuthUser, options: TokenOptions): Promise<CreatedTokenResponse> {
    this.requireManage(user);
    return this.insertToken(user, { ...options, canManage: false });
  }

  async revokeUserToken(user: AuthUser, id: string): Promise<{ id: string; revoked: true }> {
    this.requireManage(user);
    const row = await this.db.first<{ id: string }>("SELECT id FROM tokens WHERE id = ? AND user_id = ?", [id, user.id]);
    // Tokens of other users are reported as missing, not forbidden, to avoid leaking their existence.
    if (!row) throw new RegistryError("NOT_FOUND", 404, `Token ${id} not found`);
    return this.revokeToken(id);
  }

  private async insertToken(user: AuthUser, options: TokenOptions & { canManage: boolean }): Promise<CreatedTokenResponse> {
    const label = (options.label ?? "default").trim().slice(0, 100) || "default";
    let namespaces: string[] | null = null;
    if (options.namespaces !== undefined && options.namespaces !== null) {
      if (!Array.isArray(options.namespaces) || options.namespaces.length === 0 || options.namespaces.length > 20) {
        throw new RegistryError("BAD_REQUEST", 400, "namespaces must be a non-empty list of at most 20 namespaces");
      }
      for (const ns of options.namespaces) assertName(ns, "namespace");
      namespaces = [...new Set(options.namespaces)].sort();
    }
    let expiresAt: string | null = null;
    if (options.expiresInDays !== undefined && options.expiresInDays !== null) {
      const days = options.expiresInDays;
      if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
        throw new RegistryError("BAD_REQUEST", 400, `expiresInDays must be an integer between 1 and ${MAX_TOKEN_DAYS}`);
      }
      expiresAt = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    }
    const token = generateToken();
    const row: TokenRow = {
      id: crypto.randomUUID(),
      user_id: user.id,
      label,
      created_at: this.now().toISOString(),
      last_used_at: null,
      revoked_at: null,
      scope_namespaces: namespaces ? namespaces.join(",") : null,
      expires_at: expiresAt,
      can_manage: options.canManage ? 1 : 0,
    };
    await this.db.run(
      `INSERT INTO tokens (id, user_id, token_hash, label, created_at, scope_namespaces, expires_at, can_manage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, await hashToken(token), row.label, row.created_at, row.scope_namespaces, row.expires_at, row.can_manage],
    );
    return { ...toTokenInfo(row), token, user: user.name };
  }

  // ---------------------------------------------------------------- namespaces

  async getNamespace(namespace: string): Promise<NamespaceResponse> {
    assertName(namespace, "namespace");
    const row = await this.db.first<NamespaceRow & { owner_name: string | null }>(
      "SELECT n.*, u.name AS owner_name FROM namespaces n LEFT JOIN users u ON u.id = n.owner_id WHERE n.name = ?",
      [namespace],
    );
    if (!row) throw new RegistryError("NOT_FOUND", 404, `Namespace @${namespace} not found`);
    const maintainers = await this.db.all<{ name: string }>(
      `SELECT u.name AS name FROM namespace_maintainers m JOIN users u ON u.id = m.user_id
       WHERE m.namespace = ? ORDER BY u.name`,
      [namespace],
    );
    const packages = await this.db.all<{ id: string }>("SELECT id FROM packages WHERE namespace = ? ORDER BY id", [namespace]);
    return {
      namespace,
      owner: row.owner_name,
      maintainers: maintainers.map((m) => m.name),
      reserved: row.reserved === 1,
      packages: packages.map((p) => p.id),
    };
  }

  private async requireOwner(user: AuthUser, namespace: string): Promise<void> {
    this.requireManage(user);
    const row = await this.db.first<NamespaceRow>("SELECT * FROM namespaces WHERE name = ?", [namespace]);
    if (!row) throw new RegistryError("NOT_FOUND", 404, `Namespace @${namespace} not found`);
    if (row.owner_id !== user.id) throw new RegistryError("FORBIDDEN", 403, `Only the owner of @${namespace} can manage its maintainers`);
  }

  async addMaintainer(user: AuthUser, namespace: string, maintainerName: string): Promise<NamespaceResponse> {
    assertName(namespace, "namespace");
    await this.requireOwner(user, namespace);
    const maintainer = await this.getUser(maintainerName);
    if (!maintainer) throw new RegistryError("NOT_FOUND", 404, `User "${maintainerName}" not found`);
    if (maintainer.id === user.id) throw new RegistryError("BAD_REQUEST", 400, "The owner is already allowed to publish");
    await this.db.run("INSERT OR IGNORE INTO namespace_maintainers (namespace, user_id, added_at) VALUES (?, ?, ?)", [
      namespace,
      maintainer.id,
      this.now().toISOString(),
    ]);
    return this.getNamespace(namespace);
  }

  async removeMaintainer(user: AuthUser, namespace: string, maintainerName: string): Promise<NamespaceResponse> {
    assertName(namespace, "namespace");
    await this.requireOwner(user, namespace);
    const maintainer = await this.getUser(maintainerName);
    if (maintainer) {
      await this.db.run("DELETE FROM namespace_maintainers WHERE namespace = ? AND user_id = ?", [namespace, maintainer.id]);
    }
    return this.getNamespace(namespace);
  }

  // ---------------------------------------------------------------- admin

  async getUser(name: string): Promise<AuthUser | null> {
    return this.db.first<AuthUser>("SELECT id, name FROM users WHERE name = ?", [name]);
  }

  async createUser(name: string): Promise<AuthUser & { createdAt: string }> {
    assertName(name, "user name");
    const user = { id: crypto.randomUUID(), name, createdAt: this.now().toISOString() };
    try {
      await this.db.run("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)", [user.id, user.name, user.createdAt]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RegistryError("USER_EXISTS", 409, `User "${name}" already exists`);
      throw error;
    }
    return user;
  }

  /**
   * Admin: creates a token for a user. Admin-issued tokens may manage tokens and maintainers unless
   * `canManage: false`. The plaintext token is returned once and never stored.
   */
  async createToken(userName: string, options: TokenOptions & { canManage?: boolean } = {}): Promise<CreatedTokenResponse> {
    const user = await this.getUser(userName);
    if (!user) throw new RegistryError("NOT_FOUND", 404, `User "${userName}" not found`);
    return this.insertToken(user, { ...options, canManage: options.canManage ?? true });
  }

  async revokeToken(id: string): Promise<{ id: string; revoked: true }> {
    const row = await this.db.first<{ id: string; revoked_at: string | null }>("SELECT id, revoked_at FROM tokens WHERE id = ?", [id]);
    if (!row) throw new RegistryError("NOT_FOUND", 404, `Token ${id} not found`);
    if (!row.revoked_at) await this.db.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", [this.now().toISOString(), id]);
    return { id, revoked: true };
  }

  /** Assigns (or clears, with null) the owner of a namespace. Creates the namespace if needed. */
  async setNamespaceOwner(namespace: string, ownerName: string | null): Promise<{ namespace: string; owner: string | null; reserved: boolean }> {
    assertName(namespace, "namespace");
    let ownerId: string | null = null;
    if (ownerName !== null) {
      const user = await this.getUser(ownerName);
      if (!user) throw new RegistryError("NOT_FOUND", 404, `User "${ownerName}" not found`);
      ownerId = user.id;
    }
    await this.db.batch([
      {
        sql: "INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES (?, NULL, 0, ?)",
        params: [namespace, this.now().toISOString()],
      },
      { sql: "UPDATE namespaces SET owner_id = ? WHERE name = ?", params: [ownerId, namespace] },
    ]);
    const row = (await this.db.first<NamespaceRow>("SELECT * FROM namespaces WHERE name = ?", [namespace]))!;
    return { namespace, owner: ownerName, reserved: row.reserved === 1 };
  }

  // ---------------------------------------------------------------- publish

  /**
   * Ensures `user` may publish into `namespace`. Unclaimed namespaces are claimed by their first
   * publisher; reserved namespaces must be assigned by an admin.
   */
  private async authorizeNamespace(namespace: string, user: AuthUser): Promise<void> {
    if (user.token?.namespaces && !user.token.namespaces.includes(namespace)) {
      throw new RegistryError("TOKEN_SCOPE", 403, `This token may only publish to: ${user.token.namespaces.map((n) => `@${n}`).join(", ")}`);
    }
    let row = await this.db.first<NamespaceRow>("SELECT * FROM namespaces WHERE name = ?", [namespace]);
    if (!row) {
      await this.db.run("INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES (?, ?, 0, ?)", [
        namespace,
        user.id,
        this.now().toISOString(),
      ]);
      row = (await this.db.first<NamespaceRow>("SELECT * FROM namespaces WHERE name = ?", [namespace]))!;
    }
    if (row.owner_id === user.id) return;
    const maintainer = await this.db.first("SELECT 1 AS x FROM namespace_maintainers WHERE namespace = ? AND user_id = ?", [namespace, user.id]);
    if (maintainer) return;
    if (row.owner_id === null && row.reserved === 1) {
      throw new RegistryError("NAMESPACE_RESERVED", 403, `Namespace @${namespace} is reserved. Ask a registry admin for access.`);
    }
    if (row.owner_id === null) {
      // Unowned, unreserved (e.g. released by an admin): claimable, first writer wins.
      await this.db.run("UPDATE namespaces SET owner_id = ? WHERE name = ? AND owner_id IS NULL", [user.id, namespace]);
      const claimed = await this.db.first<NamespaceRow>("SELECT * FROM namespaces WHERE name = ?", [namespace]);
      if (claimed?.owner_id === user.id) return;
    }
    throw new RegistryError("FORBIDDEN", 403, `You do not have permission to publish to @${namespace}`);
  }

  /**
   * Validates and publishes an artifact (`.tar.gz`, or a legacy JSON bundle) as `user`.
   * Versions are immutable.
   *
   * Order: validate → authorize → reject existing version → upload artifact → write D1 (atomic).
   * If the upload fails, nothing is written to D1. If the D1 write fails after a successful upload,
   * the client gets 503 and can simply publish again: the artifact store treats an identical upload
   * as a no-op and replaces an unreferenced orphan with different contents.
   */
  async publish(bytes: Uint8Array, user: AuthUser): Promise<PublishResponse> {
    let files;
    try {
      files = await decodePackageArchive(bytes);
    } catch (error) {
      if (error instanceof SpecError) throw new RegistryError("INVALID_PACKAGE", 422, error.message);
      throw error;
    }
    const validation = validateBundleFiles(files);
    if (!validation.ok) throw new RegistryError("INVALID_PACKAGE", 422, "Invalid package", validation.errors);
    const manifest = validation.value;
    if (manifest.version.includes("+")) {
      throw new RegistryError("INVALID_PACKAGE", 422, "Versions with build metadata (+...) cannot be published");
    }
    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      throw new RegistryError(
        "DEPENDENCIES_UNSUPPORTED",
        422,
        "Package dependencies are reserved in the specification but not supported by the registry yet",
        Object.entries(manifest.dependencies).map(([dep, range]) => `${dep}@${range}`),
      );
    }
    const id = manifestId(manifest);

    await this.authorizeNamespace(manifest.namespace, user);

    const integrity = await computeIntegrity(bytes);
    if (!INTEGRITY_PATTERN.test(integrity)) throw new Error("unexpected integrity format");

    // Versions are immutable: identical or not, an existing version is never replaced.
    const exists = await this.db.first<{ integrity: string }>("SELECT integrity FROM versions WHERE package_id = ? AND version = ?", [id, manifest.version]);
    if (exists) {
      throw new RegistryError(
        "VERSION_EXISTS",
        409,
        exists.integrity === integrity
          ? `${id}@${manifest.version} is already published with this exact artifact (${integrity})`
          : `${id}@${manifest.version} is already published with a different artifact; versions are immutable, publish a new version`,
        [`published: ${exists.integrity}`, `submitted: ${integrity}`],
      );
    }
    const format = archiveFormat(bytes);
    const key = artifactKey(manifest.namespace, manifest.name, manifest.version, integrity, format === "tar.gz" ? ".tar.gz" : ".bundle.json");
    let stored: StoredArtifact | void;
    try {
      stored = await this.artifacts.put(key, bytes, {
        sha256: integrity.slice("sha256-".length),
        contentType: format === "tar.gz" ? ARCHIVE_CONTENT_TYPE : BUNDLE_CONTENT_TYPE,
      });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.status === 409) {
        throw new RegistryError(
          "VERSION_EXISTS",
          409,
          `A different artifact for ${id}@${manifest.version} was already stored by an earlier incomplete publish; stored artifacts are never replaced, publish a new version`,
        );
      }
      if (error instanceof ArtifactStoreError) {
        console.error(redactSecrets(`registry: artifact upload failed for ${id}@${manifest.version}: ${error.message}`));
        throw new RegistryError("ARTIFACT_STORAGE_FAILED", 502, "The artifact could not be stored. Nothing was published; try again later.");
      }
      throw error;
    }

    const stamp = this.now().toISOString();
    const existing = await this.db.first<PackageRow>("SELECT * FROM packages WHERE id = ?", [id]);
    const others = await this.db.all<{ version: string }>("SELECT version FROM versions WHERE package_id = ?", [id]);
    const latest = latestVersion([...others.map((v) => v.version), manifest.version])!;
    // The package description follows the manifest of the latest version.
    const description = !existing || latest === manifest.version ? manifest.description : existing.description;

    try {
      await this.db.batch([
        {
          sql: `INSERT INTO packages (id, namespace, name, description, latest_version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET description = excluded.description,
                  latest_version = excluded.latest_version, updated_at = excluded.updated_at`,
          params: [id, manifest.namespace, manifest.name, description, latest, stamp, stamp],
        },
        {
          sql: `INSERT INTO versions (package_id, version, manifest, integrity, size, artifact_key, artifact_backend, artifact_url, published_by, published_at, provenance)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            id,
            manifest.version,
            JSON.stringify(manifest),
            integrity,
            bytes.byteLength,
            key,
            this.artifacts.backend,
            stored?.url ?? null,
            user.id,
            stamp,
            JSON.stringify(await buildProvenance({ id, manifest, integrity, size: bytes.byteLength, format, publisher: user.name, publishedAt: stamp, via: user.token ? "token" : "internal" })),
          ],
        },
      ]);
    } catch (error) {
      // A concurrent publish of the same version won the race.
      if (isUniqueViolation(error)) throw new RegistryError("VERSION_EXISTS", 409, `${id}@${manifest.version} is already published`);
      console.error(redactSecrets(`registry: metadata write failed after storing ${key}: ${(error as Error)?.message ?? error}`));
      throw new RegistryError(
        "METADATA_WRITE_FAILED",
        503,
        `The artifact was stored but ${id}@${manifest.version} could not be registered. Publish again to retry; the upload is reused.`,
      );
    }

    return { name: id, version: manifest.version, integrity, size: bytes.byteLength, download: downloadPath(id, manifest.version) };
  }
}
