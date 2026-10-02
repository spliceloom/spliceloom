/**
 * Storage interfaces, shaped after Cloudflare D1 (async SQL over SQLite, atomic batches) and an
 * object store (key → bytes). Artifact backends: GitHub Releases (production), Workers KV, R2,
 * local files and memory.
 */

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDatabase {
  run(sql: string, params?: SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /** Executes statements atomically: all succeed or none are applied (D1 `batch`). */
  batch(statements: SqlStatement[]): Promise<void>;
  /** Releases the connection, when the backend has one. */
  close?(): Promise<void>;
}

/** Where a stored artifact can be fetched from, when the backend exposes a URL. */
export interface StoredArtifact {
  url?: string;
}

export interface ArtifactPutOptions {
  /** SHA-256 (hex) of `bytes`, so the backend can verify the upload. */
  sha256: string;
  contentType: string;
}

export interface ArtifactStore {
  /** Short identifier recorded in D1 (`versions.artifact_backend`). */
  readonly backend: string;
  /** `location` is what `put` returned earlier (lets backends skip a lookup). */
  get(key: string, location?: StoredArtifact): Promise<Uint8Array | null>;
  /**
   * Stores bytes under `key`. Must be idempotent: storing the same bytes under the same key again
   * succeeds (this is how a publish is retried after a metadata write failure).
   */
  put(key: string, bytes: Uint8Array, options: ArtifactPutOptions): Promise<StoredArtifact | void>;
}

export class ArtifactStoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

/**
 * Deterministic artifact keys: `packages/<ns>/<name>/<version>/<sha256>.<ext>`.
 * `.tar.gz` for current artifacts, `.bundle.json` for Phase 1/2 JSON bundles.
 */
export const ARTIFACT_KEY_PATTERN = /^packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/([0-9A-Za-z.-]+)\/([0-9a-f]{64})(\.tar\.gz|\.bundle\.json)$/;

export interface ParsedArtifactKey {
  namespace: string;
  name: string;
  version: string;
  sha256: string;
  extension: ".tar.gz" | ".bundle.json";
}

export function parseArtifactKey(key: string): ParsedArtifactKey {
  const match = ARTIFACT_KEY_PATTERN.exec(key);
  if (!match) throw new ArtifactStoreError(`Invalid artifact key ${key}`);
  return { namespace: match[1]!, name: match[2]!, version: match[3]!, sha256: match[4]!, extension: match[5] as ParsedArtifactKey["extension"] };
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly backend = "memory";
  private readonly items = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.items.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.items.set(key, bytes);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }
}

/** True when a database error is a UNIQUE / PRIMARY KEY violation (SQLite and D1 share the message). */
export function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(String((error as Error)?.message ?? error));
}
