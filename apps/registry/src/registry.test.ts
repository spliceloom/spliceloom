import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { packDirectory, type PackResult } from "@spliceloom/core";
import {
  computeIntegrity,
  encodeBundle,
  encodeTarGz,
  type CreatedTokenResponse,
  type ProvenanceResponse,
  type NamespaceResponse,
  type PackageResponse,
  type SearchResponse,
  type TokenListResponse,
  type VersionResponse,
  type VersionsResponse,
  type WhoamiResponse,
} from "@spliceloom/spec";
import {
  MemoryArtifactStore,
  MemoryRateLimiter,
  RegistryService,
  SqlRateLimiter,
  createRegistryHandler,
  hashToken,
  type SqlDatabase,
} from "./index.js";
import { isStorageUnavailable } from "./handler.js";
import { createSqliteDatabase, openLocalRegistry, serveRegistry } from "./node.js";
import { seedDirectories } from "./seed.js";

const ADMIN = "splice_admin_test-token";

function writeSkill(root: string, namespace: string, name: string, version: string, description = `${name} skill`): string {
  const dir = join(root, `${namespace}-${name}-${version}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace,
      name,
      version,
      description,
      tools: [{ name: "run", description: "run", entry: "tools/run.ts", input: { type: "object" } }],
    }),
  );
  writeFileSync(join(dir, "tools", "run.ts"), "export default () => ({})");
  return dir;
}

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

describe("registry", () => {
  let root: string;
  let db: SqlDatabase;
  let artifacts: MemoryArtifactStore;
  let service: RegistryService;
  let handle: (request: Request) => Promise<Response>;
  let alice: string;
  let bob: string;
  let github010: PackResult;

  const pack = (namespace: string, name: string, version: string, description?: string) =>
    packDirectory(writeSkill(root, namespace, name, version, description));

  async function api<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { token?: string; json?: unknown; body?: Uint8Array } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["content-type"] = "application/json";
    } else if (options.body) {
      body = options.body as Uint8Array<ArrayBuffer>;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    const response = await handle(new Request(`http://registry.test${path}`, init));
    const type = response.headers.get("content-type") ?? "";
    const parsed = type.includes("json") && !type.includes("splice") ? await response.json() : new Uint8Array(await response.arrayBuffer());
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  const publish = (bytes: Uint8Array, token?: string) => api("POST", "/publish", token ? { token, body: bytes } : { body: bytes });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-registry-"));
    db = createSqliteDatabase(":memory:");
    artifacts = new MemoryArtifactStore();
    service = new RegistryService(db, artifacts);
    handle = createRegistryHandler({ service, adminTokenHash: await hashToken(ADMIN) });
    github010 = await pack("alice", "github", "0.1.0", "GitHub capabilities for agents");
  });

  after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("public API: CORS for anonymous read-only routes (Phase 9)", () => {
    it("allows cross-origin reads of public routes only, never with credentials", async () => {
      for (const path of ["/", "/health", "/packages/search?q=x", "/packages/alice/nothing", "/namespaces/alice"]) {
        const r = await api("GET", path);
        assert.equal(r.headers.get("access-control-allow-origin"), "*", path);
        assert.equal(r.headers.get("access-control-allow-credentials"), null, path);
      }
      assert.match((await api("GET", "/packages/search?q=x")).headers.get("access-control-expose-headers") ?? "", /x-splice-integrity/);
      for (const [method, path] of [["GET", "/auth/whoami"], ["POST", "/publish"], ["POST", "/admin/users"], ["POST", "/mcp"], ["PUT", "/namespaces/alice/maintainers/bob"]] as const) {
        assert.equal((await api(method, path)).headers.get("access-control-allow-origin"), null, `${method} ${path}`);
      }
    });

    it("reports a database quota/outage as 503 with Retry-After, not as an internal error", async () => {
      const failing = createRegistryHandler({
        service: new Proxy(service, {
          get(target, prop, receiver) {
            if (prop === "getPackage") {
              return async () => {
                throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow.");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      });
      const original = console.error;
      console.error = () => {};
      try {
        const r = await failing(new Request("http://registry.test/packages/alice/github"));
        assert.equal(r.status, 503);
        assert.equal(r.headers.get("retry-after"), "3600");
        assert.equal(((await r.json()) as { error: { code: string } }).error.code, "STORAGE_UNAVAILABLE");
      } finally {
        console.error = original;
      }
      assert.equal(isStorageUnavailable(new Error("D1_ERROR: no such table: x")), false, "real bugs stay 500");
    });

    it("answers preflight requests for public routes and nothing else", async () => {
      const ok = await handle(new Request("http://registry.test/packages/search?q=x", { method: "OPTIONS" }));
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get("access-control-allow-methods"), "GET, OPTIONS");
      for (const path of ["/publish", "/auth/tokens", "/admin/users", "/mcp"]) {
        const r = await handle(new Request(`http://registry.test${path}`, { method: "OPTIONS" }));
        assert.equal(r.headers.get("access-control-allow-origin"), null, path);
        assert.notEqual(r.status, 204, path);
      }
    });
  });

  describe("admin API and authentication", () => {
    it("requires a valid admin token", async () => {
      assert.equal((await api("POST", "/admin/users", { json: { name: "x" } })).status, 401);
      assert.equal((await api("POST", "/admin/users", { token: "splice_admin_wrong", json: { name: "x" } })).status, 403);
      const disabled = createRegistryHandler({ service });
      const res = await disabled(new Request("http://x/admin/users", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } }));
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "ADMIN_DISABLED");
    });

    it("creates users and tokens", async () => {
      assert.equal((await api("POST", "/admin/users", { token: ADMIN, json: { name: "alice" } })).status, 201);
      assert.equal((await api("POST", "/admin/users", { token: ADMIN, json: { name: "bob" } })).status, 201);
      assert.equal((await api("POST", "/admin/users", { token: ADMIN, json: { name: "alice" } })).status, 409);
      assert.equal((await api("POST", "/admin/users", { token: ADMIN, json: { name: "Bad Name" } })).status, 400);
      assert.equal((await api("POST", "/admin/users", { token: ADMIN, json: [] })).status, 400);
      const a = await api<{ token: string; id: string }>("POST", "/admin/users/alice/tokens", { token: ADMIN, json: { label: "laptop" } });
      assert.equal(a.status, 201);
      assert.match(a.body.token, /^splice_[A-Za-z0-9_-]{43}$/);
      alice = a.body.token;
      bob = (await api<{ token: string }>("POST", "/admin/users/bob/tokens", { token: ADMIN, json: {} })).body.token;
      assert.equal((await api("POST", "/admin/users/nobody/tokens", { token: ADMIN, json: {} })).status, 404);
    });

    it("stores only token hashes", async () => {
      const rows = await db.all<Record<string, unknown>>("SELECT * FROM tokens");
      assert.equal(rows.length, 2);
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(alice) && !dump.includes(bob), "plaintext token found in database");
      const hashes = rows.map((r) => r.token_hash).sort();
      assert.deepEqual(hashes, [await hashToken(alice), await hashToken(bob)].sort());
    });

    it("identifies users with whoami", async () => {
      assert.equal((await api("GET", "/auth/whoami")).status, 401);
      assert.equal((await api("GET", "/auth/whoami", { token: "splice_not-a-real-token" })).status, 401);
      assert.equal((await api("GET", "/auth/whoami", { token: "garbage" })).status, 401);
      const me = (await api<WhoamiResponse>("GET", "/auth/whoami", { token: alice })).body;
      assert.equal(me.user, "alice");
      assert.deepEqual(me.namespaces, []);
      assert.equal(me.token.label, "laptop");
      assert.equal(me.token.canManage, true);
      assert.equal(me.token.namespaces, null);
      assert.equal(me.token.expiresAt, null);
      assert.ok(!JSON.stringify(me).includes(alice), "whoami must not echo the token");
    });

    it("rejects revoked tokens", async () => {
      const temp = await api<{ token: string; id: string }>("POST", "/admin/users/bob/tokens", { token: ADMIN, json: { label: "temp" } });
      assert.equal((await api("GET", "/auth/whoami", { token: temp.body.token })).status, 200);
      assert.equal((await api("POST", `/admin/tokens/${temp.body.id}/revoke`, { token: ADMIN })).status, 200);
      assert.equal((await api("GET", "/auth/whoami", { token: temp.body.token })).status, 401);
    });
  });

  describe("publishing and namespaces", () => {
    it("requires authentication", async () => {
      assert.equal((await publish(github010.bytes)).status, 401);
      assert.equal((await publish(github010.bytes, "splice_invalid")).status, 401);
    });

    it("publishes, claims the namespace and stores the artifact under a deterministic key", async () => {
      const res = await publish(github010.bytes, alice);
      assert.equal(res.status, 201);
      assert.deepEqual(res.body, {
        name: "@alice/github",
        version: "0.1.0",
        integrity: github010.integrity,
        size: github010.bytes.byteLength,
        download: "/packages/alice/github/0.1.0/download",
      });
      assert.deepEqual(artifacts.keys(), [`packages/alice/github/0.1.0/${github010.integrity.slice(7)}.tar.gz`]);
      const me = (await api<WhoamiResponse>("GET", "/auth/whoami", { token: alice })).body;
      assert.deepEqual([me.user, me.namespaces, me.owns, me.maintains], ["alice", ["alice"], ["alice"], []]);
    });

    it("rejects duplicate versions", async () => {
      const res = await publish(github010.bytes, alice);
      assert.equal(res.status, 409);
      assert.equal((res.body as { error: { code: string } }).error.code, "VERSION_EXISTS");
    });

    it("enforces namespace ownership", async () => {
      const res = await publish((await pack("alice", "stolen", "1.0.0")).bytes, bob);
      assert.equal(res.status, 403);
      assert.equal((res.body as { error: { code: string } }).error.code, "FORBIDDEN");
    });

    it("protects reserved namespaces until an admin assigns them", async () => {
      const example = await pack("splice", "example", "0.1.0");
      const denied = await publish(example.bytes, alice);
      assert.equal(denied.status, 403);
      assert.equal((denied.body as { error: { code: string } }).error.code, "NAMESPACE_RESERVED");
      const assigned = await api("PUT", "/admin/namespaces/splice", { token: ADMIN, json: { owner: "alice" } });
      assert.deepEqual(assigned.body, { namespace: "splice", owner: "alice", reserved: true });
      assert.equal((await publish(example.bytes, alice)).status, 201);
      assert.equal((await publish((await pack("splice", "other", "0.1.0")).bytes, bob)).status, 403);
    });

    it("lets an admin transfer a namespace", async () => {
      await api("PUT", "/admin/namespaces/alice", { token: ADMIN, json: { owner: "bob" } });
      assert.equal((await publish((await pack("alice", "moved", "1.0.0")).bytes, bob)).status, 201);
      assert.equal((await publish((await pack("alice", "moved", "1.0.1")).bytes, alice)).status, 403);
      await api("PUT", "/admin/namespaces/alice", { token: ADMIN, json: { owner: "alice" } });
    });

    it("rejects invalid packages with 422", async () => {
      const cases: Uint8Array[] = [new TextEncoder().encode("not json"), new TextEncoder().encode('{"format":"zip"}')];
      const good = await pack("alice", "bad", "1.0.0");
      // Manifest without SKILL.md.
      cases.push(encodeBundle(good.files.filter((f) => f.path !== "SKILL.md")));
      // Path traversal inside the archive.
      cases.push(new TextEncoder().encode(new TextDecoder().decode(encodeBundle(good.files)).replace('"path":"SKILL.md"', '"path":"../../SKILL.md"')));
      // Build metadata in the version.
      cases.push((await pack("alice", "meta", "1.0.0+build.1")).bytes);
      for (const bytes of cases) {
        const res = await publish(bytes, alice);
        assert.equal(res.status, 422, new TextDecoder().decode(bytes).slice(0, 80));
        assert.equal((res.body as { error: { code: string } }).error.code, "INVALID_PACKAGE");
      }
      assert.ok(artifacts.keys().every((k) => !k.includes("/bad/") && !k.includes("/meta/")));
    });

    it("rejects oversized uploads", async () => {
      const res = await api("POST", "/publish", { token: alice, body: new Uint8Array(5 * 1024 * 1024 + 1) });
      assert.equal(res.status, 413);
    });

    it("tracks the latest stable version independent of publish order", async () => {
      for (const [v, d] of [["0.3.0", "GitHub v3"], ["0.2.0", "GitHub v2"], ["1.0.0-rc.1", "GitHub rc"]] as const) {
        assert.equal((await publish((await pack("alice", "github", v, d)).bytes, alice)).status, 201);
      }
      const pkg = (await api<PackageResponse>("GET", "/packages/alice/github")).body;
      assert.equal(pkg.latest, "0.3.0");
      assert.equal(pkg.description, "GitHub v3");
    });
  });

  describe("reading", () => {
    before(async () => {
      await publish((await pack("bob", "browser", "0.1.0", "Browser automation 100%_real")).bytes, bob);
    });

    it("searches by name and description", async () => {
      const res = await api<SearchResponse>("GET", "/packages/search?q=github");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results, [{ name: "@alice/github", description: "GitHub v3", latest: "0.3.0" }]);
      assert.deepEqual((await api<SearchResponse>("GET", "/packages/search?q=automation")).body.results.map((r) => r.name), ["@bob/browser"]);
      assert.deepEqual((await api<SearchResponse>("GET", "/packages/search?q=zzz")).body.results, []);
    });

    it("treats LIKE wildcards literally", async () => {
      assert.deepEqual((await api<SearchResponse>("GET", `/packages/search?q=${encodeURIComponent("100%_")}`)).body.results.map((r) => r.name), ["@bob/browser"]);
      assert.deepEqual((await api<SearchResponse>("GET", "/packages/search?q=gi_hub")).body.results, []);
    });

    it("returns package metadata, versions and version details", async () => {
      const pkg = (await api<PackageResponse>("GET", "/packages/alice/github")).body;
      assert.equal(pkg.name, "@alice/github");
      assert.equal(pkg.versions.length, 4);
      const versions = (await api<VersionsResponse>("GET", "/packages/alice/github/versions")).body;
      assert.equal(versions.versions.find((v) => v.version === "0.1.0")?.integrity, github010.integrity);
      const version = (await api<VersionResponse>("GET", "/packages/alice/github/0.1.0")).body;
      assert.equal(version.integrity, github010.integrity);
      assert.equal(version.publishedBy, "alice");
      assert.equal(version.manifest.name, "github");
      assert.equal(version.download, "/packages/alice/github/0.1.0/download");
    });

    it("downloads artifacts with integrity metadata", async () => {
      const res = await api<Uint8Array>("GET", "/packages/alice/github/0.1.0/download");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, github010.bytes);
      assert.equal(res.headers.get("x-splice-integrity"), github010.integrity);
      assert.equal(await computeIntegrity(res.body), github010.integrity);
      assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    });

    it("returns structured errors with the right status codes", async () => {
      const cases: Array<[string, string, number]> = [
        ["GET", "/packages/alice/nope", 404],
        ["GET", "/packages/alice/github/9.9.9", 404],
        ["GET", "/packages/alice/github/9.9.9/download", 404],
        ["GET", "/packages/alice/nope/versions", 404],
        ["GET", "/packages/Bad/Name", 400],
        ["GET", "/packages/%E0%A4%A/x", 400],
        ["GET", "/nothing", 404],
        ["DELETE", "/packages/alice/github", 404],
      ];
      for (const [method, path, status] of cases) {
        const res = await api<{ error: { code: string; message: string } }>(method, path);
        assert.equal(res.status, status, `${method} ${path}`);
        assert.ok(res.body.error.code && res.body.error.message, path);
      }
    });

    it("serves health and status documents", async () => {
      assert.deepEqual((await api("GET", "/health")).body, { status: "ok", apiVersion: 2 });
      assert.equal((await api<{ apiVersion: number }>("GET", "/")).body.apiVersion, 2);
    });
  });

  describe("scoped and expiring tokens", () => {
    let ci: CreatedTokenResponse;

    it("lets a full token create a publish-only, namespace-scoped, expiring token", async () => {
      const res = await api<CreatedTokenResponse>("POST", "/auth/tokens", { token: alice, json: { label: "ci", namespaces: ["alice"], expiresInDays: 30 } });
      assert.equal(res.status, 201);
      ci = res.body;
      assert.match(ci.token, /^splice_/);
      assert.equal(ci.canManage, false);
      assert.deepEqual(ci.namespaces, ["alice"]);
      const days = (Date.parse(ci.expiresAt!) - Date.now()) / 86_400_000;
      assert.ok(days > 29.9 && days <= 30, `expiry ${ci.expiresAt}`);
    });

    it("rejects invalid token options", async () => {
      for (const json of [{ expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 1.5 }, { namespaces: [] }, { namespaces: ["Bad Name"] }, { namespaces: "alice" }]) {
        assert.equal((await api("POST", "/auth/tokens", { token: alice, json })).status, 400, JSON.stringify(json));
      }
    });

    it("limits a scoped token to its namespaces and to publishing", async () => {
      assert.equal((await publish((await pack("alice", "ci-built", "1.0.0")).bytes, ci.token)).status, 201);
      const outside = await publish((await pack("unclaimed", "x", "1.0.0")).bytes, ci.token);
      assert.equal(outside.status, 403);
      assert.equal((outside.body as { error: { code: string } }).error.code, "TOKEN_SCOPE");
      assert.equal((await api("GET", "/namespaces/unclaimed")).status, 404, "a rejected publish must not claim the namespace");
      assert.equal((await api("GET", "/auth/tokens", { token: ci.token })).status, 403);
      assert.equal((await api("POST", "/auth/tokens", { token: ci.token, json: {} })).status, 403);
      assert.equal((await api("GET", "/auth/whoami", { token: ci.token })).status, 200);
    });

    it("lists a user's own tokens without secrets", async () => {
      const res = await api<TokenListResponse>("GET", "/auth/tokens", { token: alice });
      assert.equal(res.status, 200);
      const labels = res.body.tokens.map((t) => t.label);
      assert.ok(labels.includes("laptop") && labels.includes("ci"));
      assert.ok(res.body.tokens.find((t) => t.label === "laptop")!.current);
      const dump = JSON.stringify(res.body);
      assert.ok(!dump.includes(alice) && !dump.includes(ci.token) && !dump.includes(await hashToken(alice)));
    });

    it("revokes own tokens only", async () => {
      const bobTokens = await db.all<{ id: string }>("SELECT t.id FROM tokens t JOIN users u ON u.id = t.user_id WHERE u.name = 'bob'");
      assert.equal((await api("DELETE", `/auth/tokens/${bobTokens[0]!.id}`, { token: alice })).status, 404);
      assert.equal((await api("DELETE", `/auth/tokens/${ci.id}`, { token: alice })).status, 200);
      assert.equal((await api("GET", "/auth/whoami", { token: ci.token })).status, 401);
    });

    it("rejects expired tokens", async () => {
      let now = Date.now();
      const clocked = new RegistryService(db, artifacts, () => new Date(now));
      const clockedHandle = createRegistryHandler({ service: clocked });
      const created = await clocked.createToken("bob", { label: "short", expiresInDays: 1 });
      const whoami = () => clockedHandle(new Request("http://x/auth/whoami", { headers: { authorization: `Bearer ${created.token}` } }));
      assert.equal((await whoami()).status, 200);
      now += 2 * 86_400_000;
      assert.equal((await whoami()).status, 401);
    });
  });

  describe("namespace maintainers", () => {
    it("lets the owner add maintainers who can then publish", async () => {
      assert.equal((await publish((await pack("alice", "team", "1.0.0")).bytes, bob)).status, 403);
      const added = await api<NamespaceResponse>("PUT", "/namespaces/alice/maintainers/bob", { token: alice });
      assert.equal(added.status, 200);
      assert.deepEqual(added.body.maintainers, ["bob"]);
      assert.equal(added.body.owner, "alice");
      assert.equal((await publish((await pack("alice", "team", "1.0.0")).bytes, bob)).status, 201);
      const me = (await api<WhoamiResponse>("GET", "/auth/whoami", { token: bob })).body;
      assert.deepEqual(me.maintains, ["alice"]);
      assert.ok(me.namespaces.includes("alice"));
      const info = (await api<NamespaceResponse>("GET", "/namespaces/alice")).body;
      assert.ok(info.packages.includes("@alice/team"));
    });

    it("only lets the owner manage maintainers", async () => {
      assert.equal((await api("PUT", "/namespaces/alice/maintainers/alice", { token: bob })).status, 403);
      assert.equal((await api("PUT", "/namespaces/alice/maintainers/nobody", { token: alice })).status, 404);
      assert.equal((await api("PUT", "/namespaces/alice/maintainers/bob")).status, 401);
      assert.equal((await api("PUT", "/namespaces/nope/maintainers/bob", { token: alice })).status, 404);
    });

    it("revokes publishing when a maintainer is removed", async () => {
      assert.deepEqual((await api<NamespaceResponse>("DELETE", "/namespaces/alice/maintainers/bob", { token: alice })).body.maintainers, []);
      assert.equal((await publish((await pack("alice", "team", "1.0.1")).bytes, bob)).status, 403);
    });
  });

  describe("rate limiting", () => {
    it("limits publishes per user", async () => {
      const limited = createRegistryHandler({ service, rateLimits: { publish: new MemoryRateLimiter(1, 60_000) } });
      const send = async (bytes: Uint8Array) =>
        limited(new Request("http://x/publish", { method: "POST", headers: { authorization: `Bearer ${bob}` }, body: bytes as Uint8Array<ArrayBuffer> }));
      assert.equal((await send((await pack("bob", "rl", "1.0.0")).bytes)).status, 201);
      const blocked = await send((await pack("bob", "rl", "1.0.1")).bytes);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("retry-after"), "60");
      assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "RATE_LIMITED");
    });

    it("limits authenticated and admin requests per client IP, before checking credentials", async () => {
      const limited = createRegistryHandler({
        service,
        adminTokenHash: await hashToken(ADMIN),
        rateLimits: { auth: new MemoryRateLimiter(2, 60_000), admin: new MemoryRateLimiter(1, 60_000) },
      });
      const whoami = (ip: string) => limited(new Request("http://x/auth/whoami", { headers: { "cf-connecting-ip": ip, authorization: "Bearer splice_guess" } }));
      assert.equal((await whoami("1.1.1.1")).status, 401);
      assert.equal((await whoami("1.1.1.1")).status, 401);
      assert.equal((await whoami("1.1.1.1")).status, 429, "brute force is throttled");
      assert.equal((await whoami("2.2.2.2")).status, 401, "other clients are unaffected");
      const admin = (ip: string) => limited(new Request("http://x/admin/users", { method: "POST", headers: { "cf-connecting-ip": ip, authorization: "Bearer x" }, body: "{}" }));
      assert.equal((await admin("3.3.3.3")).status, 403);
      assert.equal((await admin("3.3.3.3")).status, 429);
      assert.equal((await limited(new Request("http://x/packages/search?q=a", { headers: { "cf-connecting-ip": "1.1.1.1" } }))).status, 200, "reads are not limited");
    });

    it("blocks a client after repeated failed authentication, even with a valid token", async () => {
      const limited = createRegistryHandler({ service, rateLimits: { authFailures: new SqlRateLimiter(db, "test-fail", 3, 600) } });
      const whoami = (ip: string, token: string) =>
        limited(new Request("http://x/auth/whoami", { headers: { "cf-connecting-ip": ip, authorization: `Bearer ${token}` } }));
      assert.equal((await whoami("9.9.9.9", alice)).status, 200, "successful auth is not counted");
      for (let i = 0; i < 3; i++) assert.equal((await whoami("9.9.9.9", "splice_wrong")).status, 401);
      const blocked = await whoami("9.9.9.9", alice);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("retry-after"), "600");
      assert.match(((await blocked.json()) as { error: { message: string } }).error.message, /failed authentication/);
      assert.equal((await whoami("8.8.8.8", alice)).status, 200, "other clients are unaffected");
    });

    it("counts database-backed windows atomically and resets them", async () => {
      let t = 1_000_000_000;
      const limiter = new SqlRateLimiter(db, "test-window", 2, 60, () => t);
      const results = await Promise.all([limiter.limit("k"), limiter.limit("k"), limiter.limit("k")]);
      assert.deepEqual(results.sort(), [false, true, true]);
      assert.equal(await limiter.blocked("k"), true);
      t += 60_000;
      assert.equal(await limiter.blocked("k"), false);
      assert.equal(await limiter.limit("k"), true);
    });

    it("resets the in-memory window", async () => {
      let t = 0;
      const limiter = new MemoryRateLimiter(1, 1000, () => t);
      assert.equal(await limiter.limit("k"), true);
      assert.equal(await limiter.limit("k"), false);
      t = 1000;
      assert.equal(await limiter.limit("k"), true);
    });
  });

  describe("trust: immutability, provenance and publish rules", () => {
    it("rejects republishing a version with a different artifact, and with the identical one", async () => {
      const original = await pack("alice", "immutable", "1.0.0");
      assert.equal((await publish(original.bytes, alice)).status, 201);
      const changed = await packDirectory(writeSkill(join(root, "changed"), "alice", "immutable", "1.0.0", "different description"));
      assert.notEqual(changed.integrity, original.integrity);
      const different = await publish(changed.bytes, alice);
      assert.equal(different.status, 409);
      assert.match((different.body as { error: { message: string } }).error.message, /different artifact; versions are immutable/);
      const identical = await publish(original.bytes, alice);
      assert.equal(identical.status, 409);
      assert.match((identical.body as { error: { message: string } }).error.message, /this exact artifact/);
      const version = (await api<VersionResponse>("GET", "/packages/alice/immutable/1.0.0")).body;
      assert.equal(version.integrity, original.integrity, "metadata still points to the original artifact");
    });

    it("rejects packages that declare dependencies (reserved field)", async () => {
      const dir = writeSkill(root, "alice", "withdeps", "1.0.0");
      const manifestPath = join(dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { "@splice/example": "^0.1.0" } }));
      const res = await publish((await packDirectory(dir)).bytes, alice);
      assert.equal(res.status, 422);
      assert.equal((res.body as { error: { code: string } }).error.code, "DEPENDENCIES_UNSUPPORTED");
    });

    it("rejects hidden files smuggled into a hand-made archive", async () => {
      const good = await pack("alice", "smuggle", "1.0.0");
      const res = await publish(encodeTarGz([...good.files, { path: ".env", content: new TextEncoder().encode("SECRET=x") }]), alice);
      assert.equal(res.status, 422);
      assert.match(JSON.stringify(res.body), /disallowed file/);
    });

    it("records provenance at publish and serves it", async () => {
      const packed = await pack("alice", "provenanced", "1.0.0");
      await publish(packed.bytes, alice);
      const version = (await api<VersionResponse>("GET", "/packages/alice/provenanced/1.0.0")).body;
      const p = version.provenance!;
      assert.equal(p.recorded, true);
      assert.equal(p.registryApiVersion, 2);
      assert.deepEqual(p.publisher, { user: "alice", via: "token" });
      assert.equal(p.namespace, "alice");
      assert.deepEqual(p.artifact, { integrity: packed.integrity, size: packed.bytes.byteLength, format: "tar.gz", filename: "alice-provenanced-1.0.0.tar.gz" });
      assert.match(p.manifestSha256 ?? "", /^[0-9a-f]{64}$/);
      const res = await api<ProvenanceResponse>("GET", "/packages/alice/provenanced/1.0.0/provenance");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.provenance, p);
      assert.equal((await api("GET", "/packages/alice/provenanced/9.9.9/provenance")).status, 404);
    });

    it("derives provenance for versions published before it existed", async () => {
      // A row as a pre-Phase-5 registry wrote it: no provenance column value.
      const user = await db.first<{ id: string }>("SELECT id FROM users WHERE name = 'alice'");
      const legacy = await pack("alice", "legacy", "0.9.0");
      const key = `packages/alice/legacy/0.9.0/${legacy.integrity.slice(7)}.tar.gz`;
      await artifacts.put(key, legacy.bytes);
      await db.batch([
        { sql: "INSERT INTO packages (id, namespace, name, description, latest_version, created_at, updated_at) VALUES ('@alice/legacy', 'alice', 'legacy', 'legacy', '0.9.0', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" },
        {
          sql: "INSERT INTO versions (package_id, version, manifest, integrity, size, artifact_key, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: ["@alice/legacy", "0.9.0", JSON.stringify(legacy.manifest), legacy.integrity, legacy.bytes.byteLength, key, user!.id, "2026-01-01T00:00:00.000Z"],
        },
      ]);
      const p = (await api<VersionResponse>("GET", "/packages/alice/legacy/0.9.0")).body.provenance!;
      assert.equal(p.recorded, false);
      assert.equal(p.registryApiVersion, null);
      assert.deepEqual(p.publisher, { user: "alice", via: "unknown" });
      assert.equal(p.artifact.integrity, legacy.integrity);
      assert.equal(p.manifestSha256, null);
    });

    it("enforces immutability in the database itself", async () => {
      const where = "WHERE package_id = '@alice/provenanced' AND version = '1.0.0'";
      for (const column of ["integrity", "artifact_key", "manifest", "size", "published_by", "published_at", "version"]) {
        await assert.rejects(db.run(`UPDATE versions SET ${column} = ${column === "size" ? "1" : "'x'"} ${where}`), /published versions are immutable/, column);
      }
      await assert.rejects(db.run(`DELETE FROM versions ${where}`), /cannot be deleted/);
      await assert.rejects(db.run(`UPDATE versions SET provenance = '{}' ${where}`), /write-once/);
      // Storage location may change (e.g. backend migration) without changing the artifact identity.
      await db.run(`UPDATE versions SET artifact_url = 'https://mirror.example/x' ${where}`);
    });
  });

  describe("node adapters", () => {
    it("persists to disk, migrates idempotently, seeds and serves HTTP", async () => {
      const dataDir = join(root, "data");
      const skill = writeSkill(root, "splice", "seeded", "0.1.0");
      const local = openLocalRegistry(dataDir);
      const first = await seedDirectories(local, [skill]);
      assert.match(first[0]!, /^published @splice\/seeded@0\.1\.0/);
      assert.deepEqual(await seedDirectories(local, [skill]), ["unchanged @splice/seeded@0.1.0"]);
      await local.close();

      const reopened = openLocalRegistry(dataDir);
      const version = await reopened.getVersion("@splice/seeded", "0.1.0");
      assert.ok(existsSync(join(dataDir, "artifacts", "packages", "splice", "seeded", "0.1.0", `${version.integrity.slice(7)}.tar.gz`)));
      assert.equal(version.artifact?.backend, "fs");
      const server = await serveRegistry({ service: reopened, port: 0 });
      try {
        const res = await fetch(`${server.url}/packages/splice/seeded`);
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as PackageResponse).latest, "0.1.0");
      } finally {
        await server.close();
        await reopened.close();
      }
    });
  });
});
