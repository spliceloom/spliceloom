/**
 * End-to-end (Phase 6 package lifecycle): the local Node.js registry over HTTP and the real
 * `splice` binary as a child process, plus the SDK against the same registry.
 *
 * @splice/example 0.1.0 is published first (a copy of skills/example with its version changed);
 * 0.1.1 is published later, so `outdated`/`update` see a real new version appear.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RegistryService } from "@spliceloom/registry";
import { openLocalRegistry, serveRegistry, type RunningServer } from "@spliceloom/registry/node";
import { packDirectory } from "@spliceloom/core";
import { CoreError, Splice } from "@spliceloom/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "bin.js");
const EXAMPLE_DIR = resolve(here, "../../../skills/example");

describe("e2e: package lifecycle (splice.lock, install, outdated, update, cache)", () => {
  let root: string;
  let home: string;
  let service: RegistryService;
  let server: RunningServer;
  let publisher: Awaited<ReturnType<RegistryService["createUser"]>>;
  let example010: string;

  const splice = (cwd: string, args: string[], registry = server.url) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd,
        env: { ...process.env, SPLICE_REGISTRY: registry, SPLICE_HOME: home, NO_COLOR: "1" },
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });

  /** A second machine's checkout: only splice.json and splice.lock. */
  function checkout(from: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const file of ["splice.json", "splice.lock"]) writeFileSync(join(dir, file), readFileSync(join(from, file)));
    return dir;
  }

  const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, "splice.lock"), "utf8"));

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-lifecycle-"));
    home = join(root, "home");
    example010 = join(root, "example-0.1.0");
    cpSync(EXAMPLE_DIR, example010, { recursive: true });
    const manifestPath = join(example010, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "0.1.0" }, null, 2));

    service = openLocalRegistry(join(root, "registry-data"));
    publisher = await service.createUser("splice");
    await service.setNamespaceOwner("splice", "splice");
    await service.publish((await packDirectory(example010)).bytes, publisher);
    server = await serveRegistry({ service, port: 0 });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("init → add 0.1.0 → run → outdated/update (up to date) → 0.1.1 published → outdated → update → run → verify", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    assert.equal((await splice(project, ["init"])).code, 0);
    assert.deepEqual(readdirSync(project), ["splice.json"], "init creates only splice.json");

    const add = await splice(project, ["add", "@splice/example@^0.1.0"]);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /Installed @splice\/example@0\.1\.0/);
    assert.equal(lockOf(project).packages["@splice/example"].version, "0.1.0");
    assert.deepEqual(JSON.parse((await splice(project, ["run", "example.hello", "name=Dim"])).stdout), { message: "Hello, Dim." });

    const upToDate = await splice(project, ["outdated"]);
    assert.equal(upToDate.code, 0, upToDate.stderr);
    assert.match(upToDate.stdout, /@splice\/example\s+0\.1\.0\s+0\.1\.0\s+0\.1\.0\s+\^0\.1\.0\s+up to date/);
    assert.match(upToDate.stdout, /All packages are up to date/);
    const noop = await splice(project, ["update"]);
    assert.equal(noop.code, 0, noop.stderr);
    assert.match(noop.stdout, /Everything is up to date\. splice\.lock was not changed\./);

    await service.publish((await packDirectory(EXAMPLE_DIR)).bytes, publisher);

    const outdated = await splice(project, ["outdated"]);
    assert.equal(outdated.code, 0, outdated.stderr);
    assert.match(outdated.stdout, /Package\s+Current\s+Wanted\s+Latest\s+Range/);
    assert.match(outdated.stdout, /@splice\/example\s+0\.1\.0\s+0\.1\.1\s+0\.1\.1\s+\^0\.1\.0\s+update available/);
    assert.deepEqual(JSON.parse((await splice(project, ["outdated", "--json"])).stdout), [
      { id: "@splice/example", range: "^0.1.0", current: "0.1.0", wanted: "0.1.1", latest: "0.1.1", status: "update-available" },
    ]);

    const update = await splice(project, ["update"]);
    assert.equal(update.code, 0, update.stderr);
    assert.match(update.stderr, /Downloading @splice\/example@0\.1\.1/);
    assert.match(update.stderr, /Verifying sha256-/);
    assert.match(update.stdout, /Updated @splice\/example 0\.1\.0 -> 0\.1\.1/);
    const lock = lockOf(project).packages["@splice/example"];
    assert.equal(lock.version, "0.1.1");
    assert.equal(lock.integrity, (await packDirectory(EXAMPLE_DIR)).integrity);
    assert.equal(lock.registry, server.url);
    assert.equal(JSON.parse(readFileSync(join(project, "splice.json"), "utf8")).packages["@splice/example"], "^0.1.0", "range unchanged");

    assert.equal((await splice(project, ["list"])).stdout.trim(), "@splice/example  0.1.1");
    assert.deepEqual(JSON.parse((await splice(project, ["run", "example.hello", "name=Dim", "excited=true"])).stdout), { message: "Hello, Dim!" });
    const verify = JSON.parse((await splice(project, ["verify", "@splice/example@0.1.1", "--json"])).stdout);
    assert.equal(verify.verified, true);
    assert.equal(verify.checks.find((c: { id: string }) => c.id === "installed").status, "passed");

    // A fresh machine installs exactly what is locked.
    const fresh = checkout(project, "fresh");
    const install = await splice(fresh, ["install"]);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /Installed @splice\/example@0\.1\.1/);
    assert.deepEqual(lockOf(fresh), lockOf(project));
    assert.deepEqual(JSON.parse((await splice(fresh, ["run", "example.hello", "name=Fresh"])).stdout), { message: "Hello, Fresh." });
    assert.match((await splice(fresh, ["install"])).stdout, /already installed/);

    // Remove: the last package takes splice.lock with it.
    assert.equal((await splice(project, ["remove", "@splice/example"])).code, 0);
    assert.ok(!existsSync(join(project, "splice.lock")));
  });

  it("installs the locked version, not the newest one in range", async () => {
    const project = join(root, "pinned");
    mkdirSync(project);
    await splice(project, ["init"]);
    assert.equal((await splice(project, ["add", "@splice/example@0.1.0"])).code, 0);
    writeFileSync(join(project, "splice.json"), JSON.stringify({ specVersion: 1, packages: { "@splice/example": "^0.1.0" } }));
    const fresh = checkout(project, "pinned-fresh");
    const install = JSON.parse((await splice(fresh, ["install", "--json"])).stdout);
    assert.deepEqual(install.map((r: { name: string; version: string }) => [r.name, r.version]), [["@splice/example", "0.1.0"]]);
    assert.match((await splice(fresh, ["add", "@splice/example@^0.1.0"])).stdout, /@splice\/example@0\.1\.0 is already installed/);
  });

  it("installs offline from the verified local cache, and fails clearly without it", async () => {
    const project = join(root, "offline-source");
    mkdirSync(project);
    await splice(project, ["init"]);
    assert.equal((await splice(project, ["add", "@splice/example@^0.1.0"])).code, 0);
    const dead = "http://127.0.0.1:9";

    const offline = checkout(project, "offline");
    const install = await splice(offline, ["install"], dead);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stderr, /\(local cache\)/);
    assert.match(install.stdout, /offline: installed from the local cache, verified against splice\.lock/);
    assert.deepEqual(JSON.parse((await splice(offline, ["run", "example.hello", "name=Offline"], dead)).stdout), { message: "Hello, Offline." });

    const outdated = await splice(offline, ["outdated"], dead);
    assert.equal(outdated.code, 1);
    assert.match(outdated.stderr, /Could not reach the registry/);

    // Corrupt every cached artifact: offline installs refuse (and delete) them.
    const cacheDir = join(home, "cache", "artifacts", "sha256");
    for (const name of readdirSync(cacheDir)) writeFileSync(join(cacheDir, name), "corrupted");
    const noCache = checkout(project, "offline-nocache");
    const failed = await splice(noCache, ["install"], dead);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /not in the local cache/);
    assert.ok(!existsSync(join(noCache, ".splice", "packages")));
    const locked = lockOf(project).packages["@splice/example"].integrity.slice("sha256-".length);
    assert.ok(!readdirSync(cacheDir).includes(locked), "the corrupted entry that was looked up was deleted");
  });

  it("fails closed when splice.lock does not match the registry", async () => {
    const project = join(root, "mismatch-source");
    mkdirSync(project);
    await splice(project, ["init"]);
    assert.equal((await splice(project, ["add", "@splice/example@0.1.0"])).code, 0);
    const tampered = checkout(project, "mismatch");
    const lock = lockOf(tampered);
    lock.packages["@splice/example"].integrity = (await packDirectory(EXAMPLE_DIR)).integrity;
    writeFileSync(join(tampered, "splice.lock"), JSON.stringify(lock));
    const r = await splice(tampered, ["install"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /registry serves a different artifact for @splice\/example@0\.1\.0 than splice\.lock records/);
    assert.ok(!existsSync(join(tampered, ".splice", "packages", "@splice", "example")));
  });

  it("CLI usage: install takes no packages, add still requires one", async () => {
    const project = join(root, "usage");
    mkdirSync(project);
    await splice(project, ["init"]);
    assert.equal((await splice(project, ["install", "@splice/example"])).code, 2);
    assert.equal((await splice(project, ["add"])).code, 2);
    assert.match((await splice(project, ["install"])).stdout, /Nothing to install/);
    assert.match((await splice(project, ["outdated"])).stdout, /No packages in splice\.json/);
    assert.equal((await splice(project, ["update", "not-a-package"])).code, 2);
    assert.equal((await splice(project, ["outdated", "--accept-permissions"])).code, 2);
  });

  it("SDK: install/outdated/update use the same core as the CLI", async () => {
    const dir = join(root, "sdk");
    const sdk = new Splice({ project: dir, registry: server.url, env: { SPLICE_HOME: join(root, "sdk-home") } });
    await sdk.init();
    assert.ok(!existsSync(join(dir, "splice.lock")));
    assert.equal((await sdk.add("@splice/example@0.1.0")).version, "0.1.0");
    const config = JSON.parse(readFileSync(join(dir, "splice.json"), "utf8"));
    writeFileSync(join(dir, "splice.json"), JSON.stringify({ ...config, packages: { "@splice/example": "^0.1.0" } }));

    assert.deepEqual(await sdk.outdated(), [
      { id: "@splice/example", range: "^0.1.0", current: "0.1.0", wanted: "0.1.1", latest: "0.1.1", status: "update-available" },
    ]);
    const updated = await sdk.update();
    assert.deepEqual(updated, [{ id: "@splice/example", range: "^0.1.0", from: "0.1.0", to: "0.1.1", latest: "0.1.1", status: "updated" }]);
    assert.deepEqual((await sdk.run("example.hello", { name: "SDK" })).ok, true);
    assert.deepEqual((await sdk.update(["@splice/example"]))[0]!.status, "up-to-date");
    await assert.rejects(sdk.update(["@splice/nope"]), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED");

    const fresh = join(root, "sdk-fresh");
    mkdirSync(fresh);
    for (const file of ["splice.json", "splice.lock"]) writeFileSync(join(fresh, file), readFileSync(join(dir, file)));
    const other = new Splice({ project: fresh, registry: server.url, cache: false, env: { SPLICE_HOME: join(root, "sdk-home-2") } });
    const installed = await other.install();
    assert.deepEqual(installed.map((r) => [r.id, r.version, r.fromCache ?? false]), [["@splice/example", "0.1.1", false]]);
    assert.ok(!existsSync(join(root, "sdk-home-2")), "cache: false writes nothing to SPLICE_HOME");
    assert.equal((await (await other.load("example")).run("hello", { name: "Fresh" })).ok, true);
  });
});
