/** Node.js adapters: SQLite database (with migrations), file-system artifacts and an HTTP server. */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRegistryHandler, MAX_PUBLISH_BYTES } from "./handler.js";
import { MIGRATIONS_DIR } from "./paths.js";
import type { RateLimits } from "./ratelimit.js";
import { RegistryService } from "./service.js";
import { ARTIFACT_KEY_PATTERN, type ArtifactStore, type SqlDatabase, type SqlStatement, type SqlValue } from "./storage.js";

/**
 * Applies pending migrations from `dir`, tracked in the same `d1_migrations` table that
 * `wrangler d1 migrations apply` uses, so local SQLite and D1 share one schema history.
 */
export function applySqliteMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set((db.prepare("SELECT name FROM d1_migrations").all() as Array<{ name: string }>).map((r) => r.name));
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
  for (const file of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, file), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return pending;
}

/** Opens a SQLite database (file path or ":memory:") and applies migrations. */
export function createSqliteDatabase(path: string, migrationsDir: string = MIGRATIONS_DIR): SqlDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  applySqliteMigrations(db, migrationsDir);
  return {
    async run(sql, params: SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T>(sql: string, params: SqlValue[] = []) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async batch(statements: SqlStatement[]) {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      if (db.isOpen) db.close();
    },
  };
}

/** Local artifact store: files under `dir`, mirroring the artifact key layout. */
export class FsArtifactStore implements ArtifactStore {
  readonly backend = "fs";

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(key: string): string {
    // The key pattern excludes "..", absolute paths and backslashes, so the path stays inside `dir`.
    if (!ARTIFACT_KEY_PATTERN.test(key)) throw new Error(`Invalid artifact key ${key}`);
    return join(this.dir, ...key.split("/"));
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch {
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
}

/** Opens (and migrates) a registry stored in `dataDir` (registry.db + artifacts/). */
export function openLocalRegistry(dataDir: string): RegistryService {
  mkdirSync(dataDir, { recursive: true });
  return new RegistryService(createSqliteDatabase(join(dataDir, "registry.db")), new FsArtifactStore(join(dataDir, "artifacts")));
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_PUBLISH_BYTES + 1024) throw new Error("Request body too large");
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  const init: RequestInit = { method, headers };
  if (body) init.body = body as Uint8Array<ArrayBuffer>;
  return new Request(new URL(req.url ?? "/", origin), init);
}

export interface RunningServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Serves a registry over HTTP. Use port 0 for a random free port. */
export function serveRegistry(options: {
  service: RegistryService;
  port?: number;
  host?: string;
  adminTokenHash?: string;
  rateLimits?: RateLimits;
}): Promise<RunningServer> {
  const handlerOptions: Parameters<typeof createRegistryHandler>[0] = { service: options.service };
  if (options.adminTokenHash) handlerOptions.adminTokenHash = options.adminTokenHash;
  if (options.rateLimits) handlerOptions.rateLimits = options.rateLimits;
  const handler = createRegistryHandler(handlerOptions);
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      const response = await handler(await toRequest(req, `http://${host}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE", message: (error as Error).message } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${port}`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
