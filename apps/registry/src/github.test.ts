import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { packDirectory } from "@spliceloom/core";
import { computeIntegrity, decodePackageArchive, encodeBundle } from "@spliceloom/spec";
import {
  ArtifactStoreError,
  GitHubReleaseArtifactStore,
  MemoryArtifactStore,
  RegistryError,
  RegistryService,
  artifactKey,
  createRegistryHandler,
  type AuthUser,
  type SqlDatabase,
} from "./index.js";
import { createSqliteDatabase } from "./node.js";
import { FakeGitHub } from "./testing/fake-github.js";

const TOKEN = "github_pat_test_secret_value";

function writeSkill(root: string, name: string, version: string, salt = ""): string {
  const dir = join(root, `${name}-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name} ${version}`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace: "acme",
      name,
      version,
      description: `${name} ${version}`,
      tools: [{ name: "run", description: "run", entry: "tools/run.ts", input: { type: "object" } }],
    }),
  );
  writeFileSync(join(dir, "tools", "run.ts"), `export default () => ({ v: "${version}${salt}" })`);
  return dir;
}

const sha = (integrity: string) => integrity.slice("sha256-".length);

describe("GitHubReleaseArtifactStore", () => {
  let root: string;
  let github: FakeGitHub;
  let store: GitHubReleaseArtifactStore;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "splice-gh-"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    github = new FakeGitHub("dim", "splice-artifacts", TOKEN);
    store = new GitHubReleaseArtifactStore({ owner: "dim", repo: "splice-artifacts", token: TOKEN, apiUrl: github.baseUrl, uploadUrl: github.baseUrl, fetch: github.fetch });
  });

  it("maps keys to one release per package and deterministic asset names", () => {
    const key = artifactKey("acme", "tool", "1.2.3", `sha256-${"a".repeat(64)}`);
    assert.deepEqual(store.locate(key), { tag: "pkg/acme/tool", assetName: "acme-tool-1.2.3.tar.gz", sha256: "a".repeat(64), release: "@acme/tool" });
    assert.equal(store.locate(key.replace(".tar.gz", ".bundle.json")).assetName, "acme-tool-1.2.3.splice.json");
    assert.throws(() => store.locate("packages/../x"), ArtifactStoreError);
  });

  it("creates the release, uploads the asset and returns its public URL", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "1.0.0"));
    const key = artifactKey("acme", "tool", "1.0.0", packed.integrity);
    const stored = await store.put(key, packed.bytes, { sha256: sha(packed.integrity), contentType: "application/gzip" });
    assert.equal(stored.url, `${github.baseUrl}/dim/splice-artifacts/releases/download/pkg%2Facme%2Ftool/acme-tool-1.0.0.tar.gz`);
    assert.deepEqual(github.releases.map((r) => r.tag_name), ["pkg/acme/tool"]);
    assert.equal(github.assets[0]?.contentType, "application/gzip");
    assert.equal(github.assets[0]?.digest, `sha256:${sha(packed.integrity)}`);

    // Download via the recorded public URL, then via the API (private-repo path with redirect).
    assert.deepEqual(await store.get(key, stored), packed.bytes);
    assert.deepEqual(await store.get(key), packed.bytes);
    assert.ok(github.requests.some((r) => r.startsWith("GET /signed/")), "API download follows the signed redirect");
  });

  it("treats an identical re-upload as a no-op (publish retry)", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "1.0.0"));
    const key = artifactKey("acme", "tool", "1.0.0", packed.integrity);
    const opts = { sha256: sha(packed.integrity), contentType: "application/gzip" };
    const first = await store.put(key, packed.bytes, opts);
    const second = await store.put(key, packed.bytes, opts);
    assert.deepEqual(second, first);
    assert.equal(github.uploads, 1);
    github.omitDigest = true; // without GitHub's digest the store hashes the existing asset itself
    assert.deepEqual(await store.put(key, packed.bytes, opts), first);
    assert.equal(github.uploads, 1);
  });

  it("never replaces an existing asset with different contents (immutability)", async () => {
    const same = await packDirectory(writeSkill(root, "tool", "2.0.0"));
    const a = await packDirectory(writeSkill(root, "tool", "2.0.0"));
    assert.equal(same.integrity, a.integrity, "identical contents produce identical archives");
    const b = await packDirectory(writeSkill(root, "tool", "2.0.0", "-changed"));
    assert.notEqual(a.integrity, b.integrity);
    await store.put(artifactKey("acme", "tool", "2.0.0", a.integrity), a.bytes, { sha256: sha(a.integrity), contentType: "application/gzip" });
    await assert.rejects(
      store.put(artifactKey("acme", "tool", "2.0.0", b.integrity), b.bytes, { sha256: sha(b.integrity), contentType: "application/gzip" }),
      (e: unknown) => e instanceof ArtifactStoreError && e.status === 409 && /already exists with different content/.test(e.message),
    );
    assert.equal(github.assets.length, 1);
    assert.equal(github.assets[0]?.digest, `sha256:${sha(a.integrity)}`, "the original artifact is untouched");
    assert.ok(!github.requests.some((r) => r.startsWith("DELETE")), "nothing was deleted");
  });

  it("returns null for missing artifacts", async () => {
    assert.equal(await store.get(artifactKey("acme", "none", "1.0.0", `sha256-${"b".repeat(64)}`)), null);
  });

  it("reports GitHub failures without leaking the token", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "3.0.0"));
    const key = artifactKey("acme", "tool", "3.0.0", packed.integrity);
    const opts = { sha256: sha(packed.integrity), contentType: "application/gzip" };

    const badToken = new GitHubReleaseArtifactStore({ owner: "dim", repo: "splice-artifacts", token: "wrong", apiUrl: github.baseUrl, uploadUrl: github.baseUrl, fetch: github.fetch });
    await assert.rejects(badToken.put(key, packed.bytes, opts), (e: unknown) => e instanceof ArtifactStoreError && e.status === 401 && /token invalid or expired/.test(e.message));

    github.failures = [{ match: "/assets?name=", status: 502 }];
    await assert.rejects(store.put(key, packed.bytes, opts), (e: unknown) => {
      assert.ok(e instanceof ArtifactStoreError);
      assert.match(e.message, /asset upload failed with HTTP 502/);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });

    github.emptyRepository = true;
    const other = artifactKey("acme", "fresh", "1.0.0", packed.integrity);
    await assert.rejects(store.put(other, packed.bytes, opts), /release creation failed with HTTP 422: Repository is empty/);

    const offline = new GitHubReleaseArtifactStore({ owner: "dim", repo: "r", token: TOKEN, fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } });
    await assert.rejects(offline.put(key, packed.bytes, opts), /network error/);
  });

  it("refuses a key whose hash does not match the bytes' SHA-256", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "4.0.0"));
    await assert.rejects(
      store.put(artifactKey("acme", "tool", "4.0.0", `sha256-${"c".repeat(64)}`), packed.bytes, { sha256: sha(packed.integrity), contentType: "application/gzip" }),
      /does not match/,
    );
  });

  it("rejects invalid configuration", () => {
    assert.throws(() => new GitHubReleaseArtifactStore({ owner: "a/b", repo: "r", token: "t" }), /owner\/repo/);
    assert.throws(() => new GitHubReleaseArtifactStore({ owner: "a", repo: "r", token: "" }), /token/);
  });
});

describe("registry with GitHub Releases artifacts", () => {
  let root: string;
  let github: FakeGitHub;
  let db: SqlDatabase;
  let service: RegistryService;
  let user: AuthUser;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-gh-reg-"));
    github = new FakeGitHub("dim", "splice-artifacts", TOKEN);
    db = createSqliteDatabase(":memory:");
    service = new RegistryService(
      db,
      new GitHubReleaseArtifactStore({ owner: "dim", repo: "splice-artifacts", token: TOKEN, apiUrl: github.baseUrl, uploadUrl: github.baseUrl, fetch: github.fetch }),
    );
    user = await service.createUser("dim");
  });
  after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes: validate → .tar.gz → SHA-256 → GitHub asset → D1", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "1.0.0"));
    const res = await service.publish(packed.bytes, user);
    assert.equal(res.integrity, packed.integrity);
    const version = await service.getVersion("@acme/tool", "1.0.0");
    assert.deepEqual(version.artifact, {
      filename: "acme-tool-1.0.0.tar.gz",
      backend: "github-releases",
      url: `${github.baseUrl}/dim/splice-artifacts/releases/download/pkg%2Facme%2Ftool/acme-tool-1.0.0.tar.gz`,
    });
    const row = await db.first<Record<string, unknown>>("SELECT * FROM versions WHERE version = '1.0.0'");
    assert.ok(!JSON.stringify(row).includes(TOKEN), "no credentials in D1");

    const artifact = await service.getArtifact("@acme/tool", "1.0.0");
    assert.equal(await computeIntegrity(artifact.bytes), packed.integrity);
    assert.equal((await decodePackageArchive(artifact.bytes)).length, 3);
  });

  it("writes nothing to D1 when the GitHub upload fails", async () => {
    github.failures = [{ match: "/assets?name=", status: 500 }];
    const packed = await packDirectory(writeSkill(root, "tool", "1.1.0"));
    await assert.rejects(service.publish(packed.bytes, user), (e: unknown) => e instanceof RegistryError && e.status === 502 && e.code === "ARTIFACT_STORAGE_FAILED");
    assert.equal(await db.first("SELECT 1 AS x FROM versions WHERE version = '1.1.0'"), null);
    // A later retry succeeds.
    assert.equal((await service.publish(packed.bytes, user)).version, "1.1.0");
  });

  it("recovers when D1 fails after a successful upload", async () => {
    const packed = await packDirectory(writeSkill(root, "tool", "1.2.0"));
    let failNext = true;
    const flaky: SqlDatabase = {
      ...db,
      run: db.run.bind(db),
      all: db.all.bind(db),
      first: db.first.bind(db),
      batch: async (statements) => {
        if (failNext) {
          failNext = false;
          throw new Error("D1_ERROR: simulated outage");
        }
        return db.batch(statements);
      },
    };
    const flakyService = new RegistryService(
      flaky,
      new GitHubReleaseArtifactStore({ owner: "dim", repo: "splice-artifacts", token: TOKEN, apiUrl: github.baseUrl, uploadUrl: github.baseUrl, fetch: github.fetch }),
    );
    const uploadsBefore = github.uploads;
    await assert.rejects(flakyService.publish(packed.bytes, user), (e: unknown) => e instanceof RegistryError && e.status === 503 && e.code === "METADATA_WRITE_FAILED");
    assert.equal(await db.first("SELECT 1 AS x FROM versions WHERE version = '1.2.0'"), null, "D1 does not reference the artifact");
    assert.equal(github.uploads, uploadsBefore + 1, "the artifact was uploaded");

    const retried = await flakyService.publish(packed.bytes, user);
    assert.equal(retried.integrity, packed.integrity);
    assert.equal(github.uploads, uploadsBefore + 1, "the retry reuses the uploaded asset");
    assert.deepEqual((await flakyService.getArtifact("@acme/tool", "1.2.0")).bytes, packed.bytes);
  });

  it("serves downloads over HTTP and maps storage outages to 502", async () => {
    const handle = createRegistryHandler({ service });
    const ok = await handle(new Request("http://x/packages/acme/tool/1.0.0/download"));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/gzip");
    assert.match(ok.headers.get("content-disposition") ?? "", /acme-tool-1\.0\.0\.tar\.gz/);

    github.failures = [{ match: "/releases/download/", status: 503 }, { match: "/releases/tags/", status: 503 }];
    const down = await handle(new Request("http://x/packages/acme/tool/1.0.0/download"));
    assert.equal(down.status, 502);
    const body = await down.text();
    assert.ok(!body.includes(TOKEN));
  });

  it("migrates legacy artifacts (e.g. KV) into GitHub Releases, verifying SHA-256", async () => {
    const legacy = new MemoryArtifactStore();
    const oldDb = createSqliteDatabase(":memory:");
    const oldService = new RegistryService(oldDb, legacy);
    const oldUser = await oldService.createUser("dim");
    // A Phase 2 style JSON bundle.
    const packed = await packDirectory(writeSkill(root, "legacy", "0.1.0"));
    const bundle = encodeBundle(packed.files);
    await oldService.publish(bundle, oldUser);
    // A corrupted legacy artifact must be skipped, not copied.
    const bad = await packDirectory(writeSkill(root, "broken", "0.1.0"));
    await oldService.publish(bad.bytes, oldUser);
    const badKey = legacy.keys().find((k) => k.includes("/broken/"))!;
    await legacy.put(badKey, new Uint8Array([1, 2, 3]));
    await oldDb.run("UPDATE versions SET artifact_backend = NULL");

    const migrator = new RegistryService(
      oldDb,
      new GitHubReleaseArtifactStore({ owner: "dim", repo: "splice-artifacts", token: TOKEN, apiUrl: github.baseUrl, uploadUrl: github.baseUrl, fetch: github.fetch }),
    );
    const result = await migrator.migrateArtifacts(legacy);
    assert.deepEqual(result, { migrated: ["@acme/legacy@0.1.0"], skipped: ["@acme/broken@0.1.0"] });
    const migrated = await migrator.getVersion("@acme/legacy", "0.1.0");
    assert.equal(migrated.artifact?.backend, "github-releases");
    assert.equal(migrated.artifact?.filename, "acme-legacy-0.1.0.splice.json");
    assert.deepEqual((await migrator.getArtifact("@acme/legacy", "0.1.0")).bytes, bundle);
    assert.deepEqual(await migrator.migrateArtifacts(legacy), { migrated: [], skipped: ["@acme/broken@0.1.0"] }, "idempotent");
    await oldService.close();
  });
});
