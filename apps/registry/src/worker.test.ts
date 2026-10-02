/**
 * Worker entry: edge cache for public reads and D1 usage reporting. D1 is emulated with
 * node:sqlite (same migrations as production); the cache is an in-memory Cache API stand-in.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applySqliteMigrations } from "./node.js";
import { seedDirectories } from "./seed.js";
import { RegistryService } from "./service.js";
import { d1Database, edgeCacheTtl, handleWorkerRequest, kvArtifactStore, stalePaths, type Env } from "./worker.js";

const CACHE_STATUS_HEADER = "x-splice-cache";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Minimal D1 emulation over SQLite, reporting rows read/written like D1's result meta. */
function fakeD1(sqlite: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async all<T>() {
      const rows = sqlite.prepare(sql).all(...(params as never[])) as T[];
      return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
    },
    async first<T>() {
      return (sqlite.prepare(sql).get(...(params as never[])) as T) ?? null;
    },
    async run() {
      const r = sqlite.prepare(sql).run(...(params as never[]));
      return { meta: { rows_read: 0, rows_written: Number(r.changes) } };
    },
    sql,
    params,
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

function memoryKv() {
  const map = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      const v = map.get(key);
      return v ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : null;
    },
    async put(key: string, value: Uint8Array) {
      map.set(key, value);
    },
  };
}

function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response);
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
}

describe("worker: edge cache and D1 usage", () => {
  let root: string;
  let env: Env;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-worker-"));
    const sqlite = new DatabaseSync(":memory:");
    applySqliteMigrations(sqlite);
    const kv = memoryKv();
    env = { DB: fakeD1(sqlite) as never, ARTIFACTS_KV: kv };
    await seedDirectories(new RegistryService(d1Database(env.DB), kvArtifactStore(kv)), [join(REPO, "skills", "json")]);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("chooses cache lifetimes by route (immutable versions and artifacts, short lists, never health/auth)", () => {
    assert.equal(edgeCacheTtl("/packages/search"), 60);
    assert.equal(edgeCacheTtl("/packages/splice/json"), 60);
    assert.equal(edgeCacheTtl("/packages/splice/json/versions"), 60);
    assert.equal(edgeCacheTtl("/packages/splice/json/0.1.1"), 86_400);
    assert.equal(edgeCacheTtl("/packages/splice/json/0.1.1/provenance"), 86_400);
    assert.equal(edgeCacheTtl("/packages/splice/json/0.1.1/download"), null, "artifact bytes stay verifiable against storage");
    assert.equal(edgeCacheTtl("/namespaces/splice"), 60);
    for (const p of ["/", "/health", "/auth/whoami", "/publish", "/admin/users", "/mcp"]) assert.equal(edgeCacheTtl(p), null, p);
  });

  it("serves repeated public reads from the cache with zero database rows", async () => {
    const cache = memoryCache();
    const url = "https://registry.test/packages/search?q=json";
    const first = await handleWorkerRequest(new Request(url), env, undefined, cache);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get(CACHE_STATUS_HEADER), "MISS");
    assert.equal(first.headers.get("cache-control"), "public, max-age=60");
    const rows = Number(/rows_read=(\d+)/.exec(first.headers.get("server-timing") ?? "")?.[1]);
    assert.ok(rows > 0, "a miss reads D1");
    const second = await handleWorkerRequest(new Request(url), env, undefined, cache);
    assert.equal(second.headers.get(CACHE_STATUS_HEADER), "HIT");
    assert.match(second.headers.get("server-timing") ?? "", /rows_read=0 rows_written=0/);
    assert.deepEqual(await second.json(), await first.clone().json());
  });

  it("never caches errors, health, or requests with credentials", async () => {
    const cache = memoryCache();
    const missing = await handleWorkerRequest(new Request("https://registry.test/packages/splice/nope"), env, undefined, cache);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get(CACHE_STATUS_HEADER), null);
    await handleWorkerRequest(new Request("https://registry.test/health"), env, undefined, cache);
    await handleWorkerRequest(new Request("https://registry.test/packages/splice/json", { headers: { authorization: "Bearer x" } }), env, undefined, cache);
    assert.equal(cache.entries.size, 0);
    const health = await handleWorkerRequest(new Request("https://registry.test/health"), env, undefined, cache);
    assert.match(health.headers.get("server-timing") ?? "", /^d1;desc="rows_read=\d+ rows_written=\d+"$/);
  });

  it("does not cache artifact downloads; caches immutable version metadata for a day", async () => {
    const cache = memoryCache();
    const download = await handleWorkerRequest(new Request("https://registry.test/packages/splice/json/0.1.1/download"), env, undefined, cache);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get(CACHE_STATUS_HEADER), null);
    const version = await handleWorkerRequest(new Request("https://registry.test/packages/splice/json/0.1.1"), env, undefined, cache);
    assert.equal(version.headers.get("cache-control"), "public, max-age=86400, immutable");
    assert.deepEqual([...cache.entries.keys()], ["https://registry.test/packages/splice/json/0.1.1"]);
  });

  it("knows which cached paths a write makes stale", async () => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 201 });
    assert.deepEqual(await stalePaths(new Request("https://r.test/publish", { method: "POST" }), ok({ name: "@dim/greeter", version: "2.0.0" })), [
      "/packages/dim/greeter",
      "/packages/dim/greeter/versions",
      "/namespaces/dim",
    ]);
    assert.deepEqual(await stalePaths(new Request("https://r.test/namespaces/dim/maintainers/mallory", { method: "DELETE" }), ok({})), ["/namespaces/dim"]);
    assert.deepEqual(await stalePaths(new Request("https://r.test/admin/namespaces/acme", { method: "PUT" }), ok({})), ["/namespaces/acme"]);
    assert.deepEqual(await stalePaths(new Request("https://r.test/auth/tokens", { method: "POST" }), ok({})), []);
  });
});
