import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceProject, packDirectory } from "@spliceloom/core";
import type { LoadedPackage, ToolResult } from "@spliceloom/runtime";
import { CoreError, Splice, describeTools, type SkillRuntime } from "./index.js";

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/example");

describe("sdk (offline)", () => {
  let root: string;
  let project: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-sdk-unit-"));
    project = join(root, "project");
    const p = (await SpliceProject.init(project)).project;
    const packed = await packDirectory(EXAMPLE_DIR);
    cpSync(EXAMPLE_DIR, p.packageDir("@splice/example"), { recursive: true });
    await p.writeLock({ lockfileVersion: 1, packages: { "@splice/example": { version: packed.manifest.version, integrity: packed.integrity, registry: "file:", resolved: "file:" } } });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("describes tools from the manifest (names, schemas, annotations)", async () => {
    const splice = new Splice({ project, env: { SPLICE_HOME: join(root, "home") } });
    const tools = await splice.tools();
    assert.deepEqual(tools.map((t) => [t.name, t.qualifiedName, t.mcpName]), [
      ["example.hello", "@splice/example.hello", "splice_example_hello"],
      ["example.stats", "@splice/example.stats", "splice_example_stats"],
    ]);
    const skill = await splice.load("example");
    assert.deepEqual(skill.tool("hello")?.inputSchema, skill.manifest.tools[0]!.input);
    assert.deepEqual(skill.tool("hello")?.outputSchema, skill.manifest.tools[0]!.output);
    assert.deepEqual(skill.tool("hello")?.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    for (const alias of ["hello", "example.hello", "@splice/example.hello", "splice_example_hello"]) assert.equal(skill.tool(alias)?.tool, "hello", alias);
    assert.equal(skill.tool("nope"), undefined);
    assert.deepEqual(describeTools(skill.manifest), skill.tools);
  });

  it("runs tools through the sandboxed runtime and returns structured results", async () => {
    const splice = new Splice({ project, env: {} });
    const ok = await splice.run("example.hello", { name: "SDK" });
    assert.ok(ok.ok);
    assert.deepEqual(ok.output, { message: "Hello, SDK." });
    const bad = await (await splice.load("@splice/example")).run("hello", { name: 42 });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.error.code, "INVALID_INPUT");
    const missing = await (await splice.load("example")).run("nope", {});
    assert.equal(!missing.ok && missing.error.code, "TOOL_NOT_FOUND");
  });

  it("accepts a custom runtime implementation", async () => {
    const calls: string[] = [];
    const runtime: SkillRuntime = {
      async execute(pkg: LoadedPackage, tool: string): Promise<ToolResult> {
        calls.push(`${pkg.id}.${tool}`);
        return { ok: true, package: pkg.id, tool, output: { stub: true }, logs: "", durationMs: 0 };
      },
    };
    const splice = new Splice({ project, runtime });
    assert.deepEqual((await splice.run("@splice/example.stats", { text: "x" })).ok, true);
    assert.deepEqual(calls, ["@splice/example.stats"]);
  });

  it("fails with useful errors", async () => {
    const splice = new Splice({ project, env: {} });
    await assert.rejects(splice.load("github"), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED" && /splice search github/.test(e.hint ?? ""));
    await assert.rejects(splice.load("@splice/github"), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED");
    await assert.rejects(splice.run("nodot", {}), (e: unknown) => e instanceof CoreError);
    await assert.rejects(new Splice({ project: join(root, "not-a-project") }).list(), (e: unknown) => e instanceof CoreError && e.code === "NOT_A_PROJECT");
    await assert.rejects(new Splice({ project, env: { SPLICE_HOME: join(root, "h") }, registry: "ftp://x" }).search("x"), (e: unknown) => e instanceof CoreError && e.code === "INVALID_CONFIG");
  });

  it("refuses to load a package that requests more permissions than were granted", async () => {
    const p = (await SpliceProject.require(project))!;
    const lock = await p.readLock();
    lock.packages["@splice/example"] = { ...lock.packages["@splice/example"]!, permissions: { fs: { read: [], write: [] }, network: [], env: [] } };
    await p.writeLock(lock);
    const manifestPath = join(p.packageDir("@splice/example"), "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(original), permissions: { network: ["exfiltrate.example.com"], env: ["AWS_SECRET_ACCESS_KEY"] } }));
    try {
      const splice = new Splice({ project, env: {} });
      await assert.rejects(splice.load("example"), (e: unknown) => {
        assert.ok(e instanceof CoreError && e.code === "PERMISSIONS_NOT_GRANTED");
        assert.ok(e.details.includes("network: exfiltrate.example.com"));
        return true;
      });
      assert.deepEqual(await splice.tools(), [], "not exposed to agents either (SDK tools / MCP)");
    } finally {
      writeFileSync(manifestPath, original);
    }
    assert.equal((await new Splice({ project, env: {} }).load("example")).id, "@splice/example");
  });

  it("does not hardcode a registry: explicit option, env and project config are honoured", async () => {
    const env = { SPLICE_HOME: join(root, "home2") };
    assert.equal(await new Splice({ project, env, registry: "http://explicit.test/" }).registryUrl(), "http://explicit.test");
    assert.equal(await new Splice({ project, env: { ...env, SPLICE_REGISTRY: "local" } }).registryUrl(), "http://127.0.0.1:8787");
  });
});
