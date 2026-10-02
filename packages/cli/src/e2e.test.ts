/**
 * End-to-end (Phase 1 flow): the local Node.js registry over HTTP (seeded with skills/example)
 * and the real `splice` binary executed as a child process in a fresh project directory.
 * The Cloudflare Worker flow including publish is covered by worker-e2e.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RegistryService } from "@spliceloom/registry";
import { openLocalRegistry, serveRegistry, type RunningServer } from "@spliceloom/registry/node";
import { packDirectory } from "@spliceloom/core";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "bin.js");
const EXAMPLE_DIR = resolve(here, "../../../skills/example");

describe("e2e: init → search → info → add → list → run → remove", () => {
  let root: string;
  let project: string;
  let service: RegistryService;
  let server: RunningServer;

  // Async spawn: the registry server lives in this process, so the event loop must stay free.
  const splice = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: project,
        env: { ...process.env, SPLICE_REGISTRY: server.url, SPLICE_HOME: join(root, "home"), NO_COLOR: "1" },
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-e2e-"));
    project = join(root, "project");
    mkdirSync(project);
    service = openLocalRegistry(join(root, "registry-data"));
    const publisher = await service.createUser("splice");
    await service.setNamespaceOwner("splice", "splice");
    await service.publish((await packDirectory(EXAMPLE_DIR)).bytes, publisher);
    server = await serveRegistry({ service, port: 0 });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes a project", async () => {
    const r = await splice("init");
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(project, "splice.json")));
    assert.ok(!existsSync(join(project, "splice.lock")), "the lockfile is created by the first install");
  });

  it("searches the registry", async () => {
    const r = await splice("search", "example");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^@splice\/example\n.+\nlatest: 0\.1\.1\n$/);
    const json = JSON.parse((await splice("search", "greetings", "--json")).stdout);
    assert.deepEqual(json.results.map((x: { name: string }) => x.name), ["@splice/example"]);
    assert.match((await splice("search", "nothing-matches-this")).stdout, /No packages found/);
  });

  it("inspects a package", async () => {
    const r = await splice("info", "@splice/example");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /@splice\/example 0\.1\.1/);
    assert.match(r.stdout, /example\.hello/);
    assert.match(r.stdout, /example\.stats/);
    assert.match(r.stdout, /installed:\s+no/);
    const missing = await splice("info", "@splice/does-not-exist");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found/);
  });

  it("installs a package", async () => {
    const r = await splice("add", "@splice/example");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Resolving @splice\/example/);
    assert.match(r.stderr, /Downloading @splice\/example@0\.1\.1/);
    assert.match(r.stdout, /Installed @splice\/example@0\.1\.1/);
    const lock = JSON.parse(readFileSync(join(project, "splice.lock"), "utf8"));
    assert.equal(lock.packages["@splice/example"].version, "0.1.1");
    assert.match((await splice("add", "@splice/example")).stdout, /already installed/);
    const noMatch = await splice("add", "@splice/example@^2.0.0");
    assert.equal(noMatch.code, 1);
    assert.match(noMatch.stderr, /No version of @splice\/example matches/);
  });

  it("lists installed packages", async () => {
    const r = await splice("list");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "@splice/example  0.1.1");
  });

  it("runs tools through the sandboxed runtime", async () => {
    const hello = await splice("run", "example.hello", "name=Dim", "excited=true");
    assert.equal(hello.code, 0, hello.stderr);
    assert.deepEqual(JSON.parse(hello.stdout), { message: "Hello, Dim!" });

    const stats = await splice("run", "@splice/example.stats", "--input", JSON.stringify({ text: "a bb\nccc" }), "--json");
    assert.equal(stats.code, 0, stats.stderr);
    const envelope = JSON.parse(stats.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.output, { characters: 8, words: 3, lines: 2, longestWord: "ccc" });

    const invalid = await splice("run", "example.hello");
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /INVALID_INPUT/);
    assert.match(invalid.stderr, /input\.name: is required/);

    const unknownTool = await splice("run", "example.nope");
    assert.equal(unknownTool.code, 1);
    assert.match(unknownTool.stderr, /TOOL_NOT_FOUND/);

    const notInstalled = await splice("run", "github.search");
    assert.equal(notInstalled.code, 1);
    assert.match(notInstalled.stderr, /No installed package named "github"/);
  });

  it("removes a package", async () => {
    const r = await splice("remove", "@splice/example");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Removed @splice\/example@0\.1\.1/);
    assert.match((await splice("list")).stdout, /No packages installed/);
    assert.equal((await splice("run", "example.hello", "name=x")).code, 1);
    const again = await splice("remove", "@splice/example");
    assert.equal(again.code, 1);
    assert.match(again.stderr, /not installed/);
  });
});
