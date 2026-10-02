import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { encodeBundle, filesDigest, type PackageResponse, type VersionResponse } from "@spliceloom/spec";
import {
  ArtifactCache,
  CoreError,
  RegistryClient,
  SpliceProject,
  addPackage,
  getToken,
  installProject,
  listPackages,
  outdatedPackages,
  packDirectory,
  publishPackage,
  removeCredential,
  removePackage,
  resolveInstalledTool,
  saveCredential,
  updatePackages,
  verifyPackage,
  writeUserConfig,
  type FetchLike,
  type PackResult,
} from "./index.js";

function writeSkill(root: string, namespace: string, name: string, version: string, permissions?: object): string {
  const dir = join(root, `${namespace}-${name}-${version}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}`);
  writeFileSync(join(dir, ".env"), "SECRET=should-not-be-packed");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace,
      name,
      version,
      description: `${name} ${version}`,
      ...(permissions ? { permissions } : {}),
      tools: [{ name: "echo", description: "echo", entry: "tools/echo.ts", input: { type: "object" } }],
    }),
  );
  writeFileSync(join(dir, "tools", "echo.ts"), `export default (input) => ({ input, version: "${version}" });`);
  return dir;
}

/** A tiny in-memory registry speaking the v1 HTTP API, for installer unit tests. */
class FakeRegistry {
  readonly packs = new Map<string, PackResult[]>();
  tamper = false;
  down = false;
  lieAboutIntegrity = false;
  /** Serve a manifest that differs from the one inside the artifact (tampered metadata). */
  tamperManifest = false;
  /** Break the download stream halfway (connection dropped). */
  interrupt = false;
  /** Answer every request with 503 (e.g. the registry's database quota is exhausted). */
  unavailable = false;

  add(pack: PackResult): void {
    const id = `@${pack.manifest.namespace}/${pack.manifest.name}`;
    this.packs.set(id, [...(this.packs.get(id) ?? []), pack]);
  }

  fetch: FetchLike = async (input) => {
    if (this.down) throw new TypeError("fetch failed");
    if (this.unavailable) {
      return new Response(JSON.stringify({ error: { code: "STORAGE_UNAVAILABLE", message: "The registry database is temporarily unavailable." } }), { status: 503, headers: { "retry-after": "3600" } });
    }
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (parts[0] === "packages" && parts.length >= 3) {
      const id = `@${parts[1]}/${parts[2]}`;
      const packs = this.packs.get(id);
      if (!packs) return json({ error: { code: "NOT_FOUND", message: `Package ${id} not found` } }, 404);
      if (parts.length === 3) {
        const body: PackageResponse = {
          name: id,
          namespace: parts[1]!,
          description: "",
          latest: packs.at(-1)!.manifest.version,
          versions: packs.map((p) => ({ version: p.manifest.version, publishedAt: "2026-01-01T00:00:00.000Z" })),
          createdAt: "",
          updatedAt: "",
        };
        return json(body);
      }
      const pack = packs.find((p) => p.manifest.version === parts[3]);
      if (!pack) return json({ error: { code: "NOT_FOUND", message: "version not found" } }, 404);
      if (parts.length === 4) {
        const body: VersionResponse = {
          name: id,
          version: pack.manifest.version,
          manifest: this.tamperManifest ? { ...pack.manifest, permissions: { fs: { read: [], write: [] }, network: [], env: [] } } : pack.manifest,
          integrity: this.lieAboutIntegrity ? `sha256-${"0".repeat(64)}` : pack.integrity,
          size: pack.bytes.byteLength,
          publishedAt: "",
          publishedBy: "test",
          download: `/packages/${parts[1]}/${parts[2]}/${pack.manifest.version}/download`,
        };
        return json(body);
      }
      if (parts[4] === "download") {
        const bytes = new Uint8Array(pack.bytes);
        if (this.interrupt) {
          const half = bytes.slice(0, Math.floor(bytes.length / 2));
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(half);
              controller.error(new TypeError("terminated: other side closed"));
            },
          });
          return new Response(stream, { headers: { "x-splice-integrity": pack.integrity } });
        }
        if (this.tamper) bytes[bytes.length - 2] = 32;
        return new Response(bytes, { headers: { "x-splice-integrity": pack.integrity } });
      }
    }
    return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  };
}

describe("core", () => {
  let root: string;
  let registry: FakeRegistry;
  let client: RegistryClient;
  let project: SpliceProject;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-core-"));
    registry = new FakeRegistry();
    for (const v of ["0.1.0", "0.1.1", "0.2.0", "1.0.0-beta.1"]) registry.add(await packDirectory(writeSkill(root, "test", "demo", v)));
    registry.add(await packDirectory(writeSkill(root, "other", "demo", "1.0.0")));
    registry.add(await packDirectory(writeSkill(root, "test", "net", "1.0.0", { network: ["api.example.com"] })));
    registry.add(await packDirectory(writeSkill(root, "test", "net", "1.1.0", { network: ["api.example.com"] })));
    registry.add(await packDirectory(writeSkill(root, "test", "net", "2.0.0", { network: ["api.example.com", "evil.example.com"], env: ["TOKEN"] })));
    registry.add(await packDirectory(writeSkill(root, "test", "wide", "1.0.0")));
    registry.add(await packDirectory(writeSkill(root, "test", "wide", "1.1.0", { network: ["api.example.com"] })));
    client = new RegistryClient("http://registry.test/", registry.fetch);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(async () => {
    registry.tamper = false;
    registry.down = false;
    registry.lieAboutIntegrity = false;
    registry.tamperManifest = false;
    registry.interrupt = false;
    registry.unavailable = false;
    const dir = mkdtempSync(join(root, "project-"));
    project = (await SpliceProject.init(dir)).project;
  });

  describe("project", () => {
    it("initializes once and is found from subdirectories", async () => {
      assert.ok(existsSync(project.configPath));
      assert.ok(!existsSync(project.lockPath), "no lockfile without dependencies");
      assert.ok(!existsSync(project.stateDir), "no .splice/ without dependencies");
      const again = await SpliceProject.init(project.root);
      assert.equal(again.created, false);
      const nested = join(project.root, "a", "b");
      mkdirSync(nested, { recursive: true });
      assert.equal((await SpliceProject.find(nested))?.root, project.root);
    });

    it("fails clearly outside a project", async () => {
      const outside = mkdtempSync(join(root, "outside-"));
      await assert.rejects(SpliceProject.require(outside), (e: unknown) => e instanceof CoreError && e.code === "NOT_A_PROJECT");
    });

    it("rejects malformed splice.json", async () => {
      writeFileSync(project.configPath, JSON.stringify({ specVersion: 1, packages: { "not valid": "^1.0.0" } }));
      await assert.rejects(project.readConfig(), (e: unknown) => e instanceof CoreError && e.code === "INVALID_PROJECT");
    });

    it("resolves the registry URL with the right precedence", async () => {
      const home = mkdtempSync(join(root, "home-"));
      const env = { SPLICE_HOME: home };
      assert.equal(await project.registryUrl(env), "https://registry.spliceloom.com");
      await writeUserConfig({ registry: "http://user.test" }, env);
      assert.equal(await project.registryUrl(env), "http://user.test");
      const config = await project.readConfig();
      await project.writeConfig({ ...config, registry: "http://project.test/" });
      assert.equal(await project.registryUrl(env), "http://project.test");
      assert.equal(await project.registryUrl({ ...env, SPLICE_REGISTRY: "local" }), "http://127.0.0.1:8787");
      assert.equal(await project.registryUrl({ ...env, SPLICE_REGISTRY: "http://env" }, "production"), "https://registry.spliceloom.com");
      await assert.rejects(project.registryUrl({ ...env, SPLICE_REGISTRY: "ftp://x" }), (e: unknown) => e instanceof CoreError && e.code === "INVALID_CONFIG");
    });
  });

  describe("user config and credentials", () => {
    it("stores tokens per registry in a private file and prefers SPLICE_TOKEN", async () => {
      const home = mkdtempSync(join(root, "home-"));
      const env = { SPLICE_HOME: home };
      assert.equal(await getToken("local", env), null);
      await saveCredential("http://127.0.0.1:8787/", "splice_abc", "dim", env);
      assert.deepEqual(await getToken("local", env), { token: "splice_abc", source: "credentials", user: "dim" });
      assert.equal(await getToken("production", env), null);
      assert.deepEqual(await getToken("local", { ...env, SPLICE_TOKEN: "splice_env" }), { token: "splice_env", source: "env" });
      const file = join(home, "credentials.json");
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(await removeCredential("local", env), true);
      assert.equal(await removeCredential("local", env), false);
      assert.equal(await getToken("local", env), null);
    });

    it("publishes (dry run) without contacting the registry", async () => {
      const dir = writeSkill(root, "test", "dry", "1.0.0");
      const offline = new RegistryClient("http://unreachable.test", async () => {
        throw new TypeError("network disabled");
      });
      const result = await publishPackage(offline, dir, null, { dryRun: true });
      assert.equal(result.id, "@test/dry");
      assert.equal(result.dryRun, true);
      await assert.rejects(publishPackage(offline, dir, null), (e: unknown) => e instanceof CoreError && e.code === "NOT_LOGGED_IN");
    });
  });

  describe("pack", () => {
    it("excludes hidden files and produces a deterministic integrity", async () => {
      const dir = writeSkill(root, "test", "packme", "1.0.0");
      const a = await packDirectory(dir);
      const b = await packDirectory(dir);
      assert.equal(a.integrity, b.integrity);
      assert.deepEqual(a.files.map((f) => f.path).sort(), ["SKILL.md", "manifest.json", "tools/echo.ts"]);
    });

    it("rejects invalid packages", async () => {
      const dir = writeSkill(root, "test", "broken", "1.0.0");
      rmSync(join(dir, "SKILL.md"));
      await assert.rejects(packDirectory(dir), (e: unknown) => e instanceof CoreError && e.details.some((d) => d.includes("SKILL.md")));
    });

    it("rejects symbolic links", async (t) => {
      const dir = writeSkill(root, "test", "linked", "1.0.0");
      try {
        symlinkSync(join(root), join(dir, "escape"), "junction");
      } catch {
        t.skip("symlinks not permitted on this system");
        return;
      }
      await assert.rejects(packDirectory(dir), /Symbolic links are not allowed/);
    });
  });

  describe("install", () => {
    it("installs the latest stable version and records it", async () => {
      const steps: string[] = [];
      const result = await addPackage(project, client, "@test/demo", { onStep: (s) => steps.push(s) });
      assert.equal(result.version, "0.2.0");
      assert.equal(result.alreadyInstalled, false);
      assert.deepEqual(steps, ["resolving", "downloading", "verifying", "installing"]);
      assert.equal((await project.readConfig()).packages["@test/demo"], "^0.2.0");
      const lock = await project.readLock();
      assert.equal(lock.packages["@test/demo"]?.version, "0.2.0");
      assert.equal(lock.packages["@test/demo"]!.resolved, "http://registry.test/packages/test/demo/0.2.0/download");
      assert.ok(existsSync(join(project.packageDir("@test/demo"), "tools", "echo.ts")));
      assert.ok(!existsSync(join(project.packageDir("@test/demo"), ".env")));
      assert.ok(!existsSync(join(project.stateDir, "tmp")));
    });

    it("honours ranges, reports version changes and is idempotent", async () => {
      await addPackage(project, client, "@test/demo");
      const down = await addPackage(project, client, "@test/demo@~0.1.0");
      assert.equal(down.version, "0.1.1");
      assert.equal(down.previousVersion, "0.2.0");
      assert.equal((await project.readConfig()).packages["@test/demo"], "~0.1.0");
      const again = await addPackage(project, client, "@test/demo@~0.1.0");
      assert.equal(again.alreadyInstalled, true);
      const exact = await addPackage(project, client, "@test/demo@1.0.0-beta.1");
      assert.equal(exact.version, "1.0.0-beta.1");
    });

    it("reinstalls when files on disk are missing", async () => {
      await addPackage(project, client, "@test/demo");
      rmSync(project.packageDir("@test/demo"), { recursive: true });
      assert.equal((await listPackages(project))[0]?.status, "missing");
      const result = await addPackage(project, client, "@test/demo");
      assert.equal(result.alreadyInstalled, false);
      assert.equal((await listPackages(project))[0]?.status, "ok");
    });

    it("fails for unknown packages, unmatched ranges and unreachable registries", async () => {
      await assert.rejects(addPackage(project, client, "@test/missing"), (e: unknown) => e instanceof CoreError && e.code === "PACKAGE_NOT_FOUND");
      await assert.rejects(addPackage(project, client, "@test/demo@^5.0.0"), (e: unknown) => e instanceof CoreError && e.code === "NO_MATCHING_VERSION");
      registry.down = true;
      await assert.rejects(addPackage(project, client, "@test/demo"), (e: unknown) => e instanceof CoreError && e.code === "REGISTRY_UNREACHABLE");
    });

    it("refuses artifacts whose integrity does not match", async () => {
      registry.tamper = true;
      await assert.rejects(addPackage(project, client, "@test/demo"), (e: unknown) => e instanceof CoreError && e.code === "INTEGRITY_MISMATCH");
      assert.deepEqual(await listPackages(project), []);
      registry.tamper = false;
      registry.lieAboutIntegrity = true;
      await assert.rejects(addPackage(project, client, "@test/demo"), (e: unknown) => e instanceof CoreError && e.code === "INTEGRITY_MISMATCH");
      assert.deepEqual(await listPackages(project), []);
    });

    it("refuses a bundle whose manifest does not match the requested package", async () => {
      const evil = await packDirectory(writeSkill(root, "test", "evil", "9.9.9"));
      const impostor: PackResult = { ...evil, manifest: { ...evil.manifest, name: "impostor", version: "1.0.0" } };
      registry.add(impostor);
      await assert.rejects(
        addPackage(project, client, "@test/impostor"),
        (e: unknown) => e instanceof CoreError && e.code === "INVALID_PACKAGE" && e.details.some((d) => /artifact contains @test\/evil@9\.9\.9/.test(d)),
      );
    });

    it("refuses bundles with unsafe paths", async () => {
      const good = await packDirectory(writeSkill(root, "test", "unsafe", "1.0.0"));
      const bytes = new TextEncoder().encode(
        new TextDecoder().decode(encodeBundle(good.files)).replace('"path":"SKILL.md"', '"path":"../SKILL.md"'),
      );
      const { computeIntegrity } = await import("@spliceloom/spec");
      registry.add({ ...good, bytes, integrity: await computeIntegrity(bytes) });
      await assert.rejects(
        addPackage(project, client, "@test/unsafe"),
        (e: unknown) => e instanceof CoreError && e.code === "INVALID_PACKAGE" && e.details.some((d) => /Unsafe file path/.test(d)),
      );
      assert.ok(!existsSync(join(project.stateDir, "SKILL.md")));
    });
  });

  describe("permission consent", () => {
    it("refuses packages that request permissions unless they are accepted, installing nothing", async () => {
      await assert.rejects(addPackage(project, client, "@test/net@1.0.0"), (e: unknown) => {
        assert.ok(e instanceof CoreError);
        assert.equal(e.code, "PERMISSIONS_NOT_ACCEPTED");
        assert.ok(e.details.includes("network: api.example.com"));
        return true;
      });
      assert.ok(!existsSync(project.packageDir("@test/net")));
      assert.deepEqual(await listPackages(project), []);

      const declined: string[] = [];
      await assert.rejects(
        addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: (_p, pkg) => (declined.push(pkg), false) }),
        (e: unknown) => e instanceof CoreError && e.code === "PERMISSIONS_NOT_ACCEPTED",
      );
      assert.deepEqual(declined, ["@test/net@1.0.0"]);

      const result = await addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true });
      assert.equal(result.version, "1.0.0");
      const entry = (await project.readLock()).packages["@test/net"]!;
      assert.deepEqual(entry.permissions, { fs: { read: [], write: [] }, network: ["api.example.com"], env: [] }, "the grant is recorded");
    });

    it("needs no new consent for an upgrade within the grant, but does when permissions widen", async () => {
      await addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true });
      assert.equal((await addPackage(project, client, "@test/net@1.1.0")).version, "1.1.0");
      await assert.rejects(addPackage(project, client, "@test/net@2.0.0"), (e: unknown) => {
        assert.ok(e instanceof CoreError && e.code === "PERMISSIONS_NOT_ACCEPTED");
        assert.ok(e.details.some((d) => d.includes("evil.example.com")));
        return true;
      });
      assert.equal((await project.readLock()).packages["@test/net"]!.version, "1.1.0", "the installed version is unchanged");
    });

    it("marks installed packages whose manifest was edited to request more as invalid", async () => {
      await addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true });
      const manifestPath = join(project.packageDir("@test/net"), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, permissions: { network: ["api.example.com"], fs: { read: ["."] } } }));
      assert.equal((await listPackages(project))[0]?.status, "invalid");
    });
  });

  describe("lifecycle: splice.lock, install, outdated, update, cache", () => {
    const isCode = (code: string) => (e: unknown) => e instanceof CoreError && e.code === code;
    const readText = (path: string) => readFileSync(path, "utf8");
    const installedVersion = (p: SpliceProject, id: string) =>
      JSON.parse(readFileSync(join(p.packageDir(id), "manifest.json"), "utf8")).version as string;

    /** A second checkout of the same project: only splice.json and splice.lock are copied. */
    async function freshCheckout(from: SpliceProject): Promise<SpliceProject> {
      const dir = mkdtempSync(join(root, "checkout-"));
      writeFileSync(join(dir, "splice.json"), readText(from.configPath));
      if (existsSync(from.lockPath)) writeFileSync(join(dir, "splice.lock"), readText(from.lockPath));
      return (await SpliceProject.find(dir))!;
    }

    it("creates splice.lock on the first install with version, SHA-256, size, registry and grant; removes it with the last package", async () => {
      const pack = registry.packs.get("@test/demo")!.find((p) => p.manifest.version === "0.1.0")!;
      await addPackage(project, client, "@test/demo@0.1.0");
      const lock = JSON.parse(readText(project.lockPath));
      assert.deepEqual(lock, {
        lockfileVersion: 1,
        packages: {
          "@test/demo": {
            version: "0.1.0",
            integrity: pack.integrity,
            size: pack.bytes.byteLength,
            files: await filesDigest(pack.files),
            registry: "http://registry.test",
            resolved: "http://registry.test/packages/test/demo/0.1.0/download",
            permissions: { fs: { read: [], write: [] }, network: [], env: [] },
          },
        },
      });
      assert.ok(!existsSync(project.legacyLockPath));
      await removePackage(project, "@test/demo");
      assert.ok(!existsSync(project.lockPath), "a project without packages has no lockfile");
      assert.ok(!existsSync(project.stateDir), "empty .splice/ is removed too");
    });

    it("reads a pre-Phase-6 splice-lock.json and migrates it to splice.lock", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      const entry = JSON.parse(readText(project.lockPath)).packages["@test/demo"];
      const legacy = { lockfileVersion: 1, packages: { "@test/demo": { version: entry.version, integrity: entry.integrity, resolved: entry.resolved } } };
      rmSync(project.lockPath);
      writeFileSync(project.legacyLockPath, JSON.stringify(legacy));

      const read = (await project.readLock()).packages["@test/demo"]!;
      assert.equal(read.registry, "http://registry.test", "registry derived from the resolved URL");
      const result = await installProject(project, client);
      assert.equal(result[0]!.alreadyInstalled, true);
      assert.ok(existsSync(project.lockPath));
      assert.ok(!existsSync(project.legacyLockPath));
      assert.equal(JSON.parse(readText(project.lockPath)).packages["@test/demo"].registry, "http://registry.test");
    });

    it("add keeps the locked version when it satisfies the requested range", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      const config = await project.readConfig();
      await project.writeConfig({ ...config, packages: { "@test/demo": "^0.1.0" } });
      const again = await addPackage(project, client, "@test/demo@^0.1.0");
      assert.equal(again.version, "0.1.0", "0.1.1 exists but the lock wins");
      assert.equal(again.alreadyInstalled, true);
      const latest = await addPackage(project, client, "@test/demo");
      assert.equal(latest.version, "0.2.0", "no range = newest stable, as before");
    });

    it("outdated reports current, wanted (in range) and latest; update respects the range", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/demo": "^0.1.0" } });
      const configBefore = readText(project.configPath);

      assert.deepEqual(await outdatedPackages(project, client), [
        { id: "@test/demo", range: "^0.1.0", current: "0.1.0", wanted: "0.1.1", latest: "0.2.0", status: "update-available" },
      ]);

      const steps: string[] = [];
      const updated = await updatePackages(project, client, [], { onStep: (s) => steps.push(s) });
      assert.deepEqual(updated, [{ id: "@test/demo", range: "^0.1.0", from: "0.1.0", to: "0.1.1", latest: "0.2.0", status: "updated" }]);
      assert.deepEqual(steps, ["resolving", "downloading", "verifying", "installing"]);
      assert.equal(installedVersion(project, "@test/demo"), "0.1.1");
      const lock = (await project.readLock()).packages["@test/demo"]!;
      assert.equal(lock.version, "0.1.1");
      assert.equal(lock.integrity, registry.packs.get("@test/demo")!.find((p) => p.manifest.version === "0.1.1")!.integrity);
      assert.equal(readText(project.configPath), configBefore, "the range in splice.json is not changed");
      assert.equal((await listPackages(project))[0]!.status, "ok");

      const lockText = readText(project.lockPath);
      assert.deepEqual(await updatePackages(project, client), [{ id: "@test/demo", range: "^0.1.0", from: "0.1.1", to: "0.1.1", latest: "0.2.0", status: "up-to-date" }]);
      assert.equal(readText(project.lockPath), lockText, "an up-to-date project is not rewritten");
      assert.equal((await outdatedPackages(project, client))[0]!.status, "up-to-date");
    });

    it("update reports ranges with no matching version and unknown packages clearly", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/demo": "^5.0.0" } });
      assert.deepEqual(await updatePackages(project, client), [{ id: "@test/demo", range: "^5.0.0", from: "0.1.0", to: null, latest: "0.2.0", status: "no-match" }]);
      assert.equal((await outdatedPackages(project, client))[0]!.status, "no-match");
      assert.equal(installedVersion(project, "@test/demo"), "0.1.0");
      await assert.rejects(updatePackages(project, client, ["@test/other"]), isCode("NOT_INSTALLED"));
      const empty = (await SpliceProject.init(mkdtempSync(join(root, "empty-")))).project;
      assert.deepEqual(await outdatedPackages(empty, client), []);
      assert.deepEqual(await updatePackages(empty, client), []);
    });

    it("a failed update keeps the previous version installed and locked", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/demo": "^0.1.0" } });
      const lockBefore = readText(project.lockPath);
      const configBefore = readText(project.configPath);
      const unchanged = async () => {
        assert.equal(installedVersion(project, "@test/demo"), "0.1.0");
        assert.equal(readText(project.lockPath), lockBefore);
        assert.equal(readText(project.configPath), configBefore);
        assert.equal((await listPackages(project))[0]!.status, "ok");
        assert.ok(!existsSync(join(project.stateDir, "tmp")));
      };

      registry.tamper = true;
      await assert.rejects(updatePackages(project, client), isCode("INTEGRITY_MISMATCH"));
      await unchanged();
      registry.tamper = false;

      registry.down = true;
      await assert.rejects(updatePackages(project, client), isCode("REGISTRY_UNREACHABLE"));
      await assert.rejects(outdatedPackages(project, client), isCode("REGISTRY_UNREACHABLE"));
      await unchanged();
      registry.down = false;

      // Failure after the new files are in place (writing splice.lock fails): rolled back.
      const blocker = `${project.lockPath}.${process.pid}.tmp`;
      mkdirSync(blocker);
      await assert.rejects(updatePackages(project, client));
      rmSync(blocker, { recursive: true });
      await unchanged();

      assert.equal((await updatePackages(project, client))[0]!.to, "0.1.1", "succeeds once the problem is gone");
    });

    it("an interrupted download installs nothing and keeps the previous version (Phase 8)", async () => {
      registry.interrupt = true;
      await assert.rejects(addPackage(project, client, "@test/demo@0.1.0"));
      assert.deepEqual(await listPackages(project), []);
      assert.ok(!existsSync(project.lockPath));
      assert.ok(!existsSync(join(project.stateDir, "tmp")));
      registry.interrupt = false;

      await addPackage(project, client, "@test/demo@0.1.0");
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/demo": "^0.1.0" } });
      const lockBefore = readText(project.lockPath);
      registry.interrupt = true;
      await assert.rejects(updatePackages(project, client));
      assert.equal(installedVersion(project, "@test/demo"), "0.1.0");
      assert.equal(readText(project.lockPath), lockBefore);
      assert.equal((await listPackages(project))[0]!.status, "ok");
    });

    it("a temporarily unavailable registry (503) is explained and locked installs use the verified cache (Phase 9)", async () => {
      const cache = new ArtifactCache(mkdtempSync(join(root, "cache-")));
      await addPackage(project, client, "@test/demo@0.1.0", { cache });
      registry.unavailable = true;
      await assert.rejects(outdatedPackages(project, client), (e: unknown) => {
        assert.ok(e instanceof CoreError);
        assert.equal(e.code, "REGISTRY_UNAVAILABLE");
        assert.match(e.hint ?? "", /temporarily unavailable\. Nothing was changed/);
        return true;
      });
      const checkout = mkdtempSync(join(root, "checkout-503-"));
      writeFileSync(join(checkout, "splice.json"), readText(project.configPath));
      writeFileSync(join(checkout, "splice.lock"), readText(project.lockPath));
      const result = await installProject((await SpliceProject.find(checkout))!, client, { cache });
      assert.equal(result[0]!.offline, true);
    });

    it("the lock's files digest detects and repairs modified installed files (Phase 8)", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      const entry = (await project.readLock()).packages["@test/demo"]!;
      assert.match(entry.files ?? "", /^sha256-[0-9a-f]{64}$/);
      writeFileSync(join(project.packageDir("@test/demo"), "tools", "echo.ts"), "export default () => ({ pwned: true })");
      assert.equal((await listPackages(project))[0]!.status, "invalid");
      await assert.rejects(resolveInstalledTool(project, "demo.echo"), (e: unknown) => e instanceof CoreError && e.code === "INSTALLED_PACKAGE_MODIFIED");
      const repaired = await installProject(project, client);
      assert.equal(repaired[0]!.alreadyInstalled, false, "reinstalled from the verified artifact");
      assert.equal((await listPackages(project))[0]!.status, "ok");
      assert.doesNotMatch(readText(join(project.packageDir("@test/demo"), "tools", "echo.ts")), /pwned/);
      // A lock entry whose digest was edited is refused too (never trusted over the files).
      const lock = JSON.parse(readText(project.lockPath));
      lock.packages["@test/demo"].files = `sha256-${"1".repeat(64)}`;
      writeFileSync(project.lockPath, JSON.stringify(lock));
      await assert.rejects(resolveInstalledTool(project, "demo.echo"), (e: unknown) => e instanceof CoreError && e.code === "INSTALLED_PACKAGE_MODIFIED");
    });

    it("update asks again for consent when the new version widens permissions", async () => {
      await addPackage(project, client, "@test/wide@1.0.0");
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/wide": "^1.0.0" } });
      await assert.rejects(updatePackages(project, client), (e: unknown) => isCode("PERMISSIONS_NOT_ACCEPTED")(e) && (e as CoreError).details.includes("network: api.example.com"));
      assert.equal(installedVersion(project, "@test/wide"), "1.0.0");
      assert.equal((await project.readLock()).packages["@test/wide"]!.version, "1.0.0");
      // Registry metadata that hides the requested permissions is caught by verification.
      registry.tamperManifest = true;
      await assert.rejects(updatePackages(project, client, [], { acceptPermissions: true }), isCode("INVALID_PACKAGE"));
      registry.tamperManifest = false;
      assert.equal(installedVersion(project, "@test/wide"), "1.0.0");
      const updated = await updatePackages(project, client, ["@test/wide"], { acceptPermissions: true });
      assert.equal(updated[0]!.to, "1.1.0");
      assert.deepEqual((await project.readLock()).packages["@test/wide"]!.permissions?.network, ["api.example.com"]);
    });

    it("installs a fresh checkout exactly from splice.lock, even when newer versions exist", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      await addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true });
      await project.writeConfig({ ...(await project.readConfig()), packages: { "@test/demo": "^0.1.0", "@test/net": "^1.0.0" } });

      const checkout = await freshCheckout(project);
      const results = await installProject(checkout, client);
      assert.deepEqual(results.map((r) => [r.id, r.version, r.alreadyInstalled]), [
        ["@test/demo", "0.1.0", false],
        ["@test/net", "1.0.0", false],
      ]);
      assert.equal(readText(checkout.lockPath), readText(project.lockPath), "identical lockfile");
      assert.equal(installedVersion(checkout, "@test/demo"), "0.1.0", "0.1.1 is in range but not locked");
      assert.ok((await installProject(checkout, client)).every((r) => r.alreadyInstalled));
      const report = await verifyPackage(client, "@test/demo@0.1.0", { project: checkout });
      assert.equal(report.checks.find((c) => c.id === "installed")?.status, "passed");
    });

    it("locked permission grants carry over; a lock without a grant needs consent", async () => {
      await addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true });
      const withGrant = await freshCheckout(project);
      assert.equal((await installProject(withGrant, client))[0]!.version, "1.0.0");

      const noGrant = await freshCheckout(project);
      const lock = JSON.parse(readText(noGrant.lockPath));
      delete lock.packages["@test/net"].permissions;
      writeFileSync(noGrant.lockPath, JSON.stringify(lock));
      await assert.rejects(installProject(noGrant, client), isCode("PERMISSIONS_NOT_ACCEPTED"));
      assert.ok(!existsSync(noGrant.packageDir("@test/net")));
    });

    it("fails closed when the registry does not match splice.lock", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");

      const wrongHash = await freshCheckout(project);
      const lock = JSON.parse(readText(wrongHash.lockPath));
      lock.packages["@test/demo"].integrity = registry.packs.get("@test/demo")!.find((p) => p.manifest.version === "0.1.1")!.integrity;
      writeFileSync(wrongHash.lockPath, JSON.stringify(lock));
      const lockText = readText(wrongHash.lockPath);
      await assert.rejects(installProject(wrongHash, client), (e: unknown) => isCode("LOCK_MISMATCH")(e) && /different artifact/.test((e as Error).message));
      assert.ok(!existsSync(wrongHash.packageDir("@test/demo")), "nothing installed");
      assert.equal(readText(wrongHash.lockPath), lockText, "lockfile untouched");
      // The same pin applies to `add` of the locked version.
      await assert.rejects(addPackage(wrongHash, client, "@test/demo@0.1.0"), isCode("LOCK_MISMATCH"));

      const wrongSize = await freshCheckout(project);
      const sized = JSON.parse(readText(wrongSize.lockPath));
      sized.packages["@test/demo"].size += 1;
      writeFileSync(wrongSize.lockPath, JSON.stringify(sized));
      await assert.rejects(installProject(wrongSize, client), isCode("LOCK_MISMATCH"));

      const missing = await freshCheckout(project);
      const gone = JSON.parse(readText(missing.lockPath));
      gone.packages["@test/demo"].version = "0.1.5";
      writeFileSync(missing.lockPath, JSON.stringify(gone));
      await missing.writeConfig({ ...(await missing.readConfig()), packages: { "@test/demo": "^0.1.0" } });
      await assert.rejects(installProject(missing, client), (e: unknown) => isCode("LOCK_MISMATCH")(e) && /does not have it/.test((e as Error).message));

      const outOfRange = await freshCheckout(project);
      await outOfRange.writeConfig({ ...(await outOfRange.readConfig()), packages: { "@test/demo": "^0.2.0" } });
      await assert.rejects(installProject(outOfRange, client), (e: unknown) => isCode("LOCK_MISMATCH")(e) && /splice update/.test((e as CoreError).hint ?? ""));
    });

    it("rejects a malformed splice.lock", async () => {
      await addPackage(project, client, "@test/demo@0.1.0");
      const lock = JSON.parse(readText(project.lockPath));
      lock.packages["@test/demo"].integrity = "md5-abc";
      writeFileSync(project.lockPath, JSON.stringify(lock));
      await assert.rejects(project.readLock(), (e: unknown) => isCode("INVALID_PROJECT")(e) && /splice\.lock/.test((e as Error).message));
    });

    it("caches verified artifacts by SHA-256, reuses them and installs offline from them", async () => {
      const cache = new ArtifactCache(mkdtempSync(join(root, "cache-")));
      await addPackage(project, client, "@test/demo@0.1.0", { cache });
      const integrity = (await project.readLock()).packages["@test/demo"]!.integrity;
      const hex = integrity.slice("sha256-".length);
      assert.deepEqual(readdirSync(join(cache.dir, "sha256")), [hex], "only the artifact, named by its SHA-256");

      // Online, a cached artifact skips the download but is still verified.
      const online = await freshCheckout(project);
      const steps: string[] = [];
      const cached = await installProject(online, client, { cache, onStep: (s, d) => steps.push(`${s} ${d}`) });
      assert.equal(cached[0]!.fromCache, true);
      assert.ok(steps.some((s) => s.startsWith("verifying")));
      assert.ok(steps.some((s) => s.includes("(local cache)")));

      // Offline: locked version from the verified cache.
      registry.down = true;
      const offline = await freshCheckout(project);
      const result = await installProject(offline, client, { cache });
      assert.equal(result[0]!.offline, true);
      assert.equal(installedVersion(offline, "@test/demo"), "0.1.0");
      assert.equal(readText(offline.lockPath), readText(project.lockPath));
      // `add` of the locked package works offline too; outdated/update need the registry.
      const offlineAdd = await freshCheckout(project);
      assert.equal((await addPackage(offlineAdd, client, "@test/demo@^0.1.0", { cache })).offline, true);
      await assert.rejects(addPackage(offlineAdd, client, "@test/net", { cache }), isCode("REGISTRY_UNREACHABLE"));

      // Without a cached copy (or without a cache) offline installs fail with a network error.
      await assert.rejects(installProject(await freshCheckout(project), client), isCode("REGISTRY_UNREACHABLE"));
      await assert.rejects(installProject(await freshCheckout(project), client, { cache: new ArtifactCache(join(root, "empty-cache")) }), (e: unknown) =>
        isCode("REGISTRY_UNREACHABLE")(e) && /not in the local cache/.test((e as Error).message),
      );
    });

    it("never trusts a corrupted cache entry", async () => {
      const cache = new ArtifactCache(mkdtempSync(join(root, "cache-")));
      await addPackage(project, client, "@test/demo@0.1.0", { cache });
      const integrity = (await project.readLock()).packages["@test/demo"]!.integrity;
      const entry = join(cache.dir, "sha256", integrity.slice("sha256-".length));
      const bytes = readFileSync(entry);
      bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0xff;
      writeFileSync(entry, bytes);

      registry.down = true;
      await assert.rejects(installProject(await freshCheckout(project), client, { cache }), isCode("REGISTRY_UNREACHABLE"));
      assert.ok(!existsSync(entry), "the corrupted entry was deleted");
      registry.down = false;

      // Online it is simply downloaded again (and re-cached after verification).
      const again = await installProject(await freshCheckout(project), client, { cache });
      assert.equal(again[0]!.fromCache, undefined);
      assert.ok(existsSync(entry));
      assert.equal(await cache.put(integrity, new Uint8Array([1, 2, 3])), false, "bytes that do not match their key are never stored");
    });
  });

  describe("verification", () => {
    it("verifies a published version and, when installed, the installed files", async () => {
      const report = await verifyPackage(client, "@test/demo@0.2.0", { project });
      assert.equal(report.verified, true, JSON.stringify(report.checks));
      assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [
        ["sha256", "passed"],
        ["size", "passed"],
        ["package", "passed"],
        ["metadata", "passed"],
        ["signature", "skipped"],
        ["provenance", "skipped"],
        ["source", "skipped"],
        ["installed", "skipped"],
      ]);
      await addPackage(project, client, "@test/demo@0.2.0");
      const installed = await verifyPackage(client, "@test/demo@0.2.0", { project });
      assert.equal(installed.checks.find((c) => c.id === "installed")?.status, "passed");

      writeFileSync(join(project.packageDir("@test/demo"), "tools", "echo.ts"), "export default () => ({ pwned: true })");
      const modified = await verifyPackage(client, "@test/demo@0.2.0", { project });
      assert.equal(modified.verified, false);
      assert.match(modified.checks.find((c) => c.id === "installed")!.message, /differ from the artifact/);
    });

    it("reports tampered artifacts and tampered metadata without throwing", async () => {
      registry.tamper = true;
      const tampered = await verifyPackage(client, "@test/demo@0.2.0");
      assert.equal(tampered.verified, false);
      assert.equal(tampered.checks[0]!.status, "failed");
      registry.tamper = false;

      registry.tamperManifest = true;
      const metadata = await verifyPackage(client, "@test/net@1.0.0");
      assert.equal(metadata.verified, false);
      assert.equal(metadata.checks.find((c) => c.id === "metadata")?.status, "failed");
      // The installer refuses the same tampered metadata.
      await assert.rejects(addPackage(project, client, "@test/net@1.0.0", { acceptPermissions: true }), (e: unknown) => e instanceof CoreError && e.code === "INVALID_PACKAGE");
      assert.ok(!existsSync(project.packageDir("@test/net")));
    });

    it("throws for unknown packages and unmatched ranges (not verification failures)", async () => {
      await assert.rejects(verifyPackage(client, "@test/missing"), (e: unknown) => e instanceof CoreError && e.code === "PACKAGE_NOT_FOUND");
      await assert.rejects(verifyPackage(client, "@test/demo@^9.0.0"), (e: unknown) => e instanceof CoreError && e.code === "NO_MATCHING_VERSION");
    });
  });

  describe("list, remove and tool resolution", () => {
    it("lists, resolves and removes packages", async () => {
      await addPackage(project, client, "@test/demo");
      assert.deepEqual(await listPackages(project), [{ id: "@test/demo", range: "^0.2.0", version: "0.2.0", status: "ok" }]);

      const { pkg, tool } = await resolveInstalledTool(project, "demo.echo");
      assert.equal(pkg.id, "@test/demo");
      assert.equal(tool, "echo");

      const removed = await removePackage(project, "@test/demo");
      assert.deepEqual(removed, { id: "@test/demo", version: "0.2.0" });
      assert.deepEqual(await listPackages(project), []);
      assert.ok(!existsSync(project.packageDir("@test/demo")));
      assert.ok(!existsSync(join(project.packagesDir, "@test")));
      const config = JSON.parse(readFileSync(project.configPath, "utf8"));
      assert.deepEqual(config.packages, {});
    });

    it("reports missing and ambiguous tools", async () => {
      await assert.rejects(resolveInstalledTool(project, "demo.echo"), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED");
      await addPackage(project, client, "@test/demo");
      await addPackage(project, client, "@other/demo");
      await assert.rejects(resolveInstalledTool(project, "demo.echo"), (e: unknown) => e instanceof CoreError && e.code === "AMBIGUOUS_TOOL");
      assert.equal((await resolveInstalledTool(project, "@other/demo.echo")).pkg.id, "@other/demo");
    });

    it("fails to remove packages that are not installed", async () => {
      await assert.rejects(removePackage(project, "@test/demo"), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED");
    });
  });
});
