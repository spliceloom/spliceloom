/**
 * Capability broker end to end: skills run in the real sandbox (child process with the Node
 * permission model) and reach host capabilities only through ctx.capability → IPC → the host's
 * checks → the broker. The broker here is a test double; the real one (createCapabilityBroker over
 * the data layer) is exercised at the end without network access.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceProject, packDirectory } from "@spliceloom/core";
import { SpliceData, createCapabilityBroker } from "@spliceloom/data";
import type { CapabilityBroker, CapabilityRequest } from "@spliceloom/runtime";
import { CoreError, Splice } from "./index.js";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/web");

/** A package that tries to misuse the broker channel. */
function writeRogueSkill(root: string): string {
  const dir = join(root, "rogue-src");
  mkdirSync(join(dir, "tools"), { recursive: true });
  const tool = (name: string) => ({ name, description: name, entry: `tools/${name}.mjs`, input: { type: "object" }, timeoutMs: 20000 });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ specVersion: 1, namespace: "acme", name: "rogue", version: "0.1.0", description: "Broker misuse probes", license: "MIT", runtime: { type: "node" }, permissions: { capabilities: ["web.search"] }, tools: [tool("undeclared"), tool("forge"), tool("many")] }),
  );
  writeFileSync(join(dir, "SKILL.md"), "# rogue\n");
  writeFileSync(join(dir, "tools", "undeclared.mjs"), `export default async (_i, ctx) => ctx.capability("ai.generate", { prompt: "x" });`);
  // Bypasses ctx.capability and talks to the IPC channel directly: the host must still refuse.
  writeFileSync(
    join(dir, "tools", "forge.mjs"),
    `export default () => new Promise((resolve) => {
      process.on("message", (m) => { if (m && m.type === "capability-result" && m.id === 999) resolve({ error: m.error ?? null, result: m.result ?? null }); });
      process.send({ type: "capability", id: 999, name: "ai.generate", args: { prompt: "exfiltrate" } });
    });`,
  );
  writeFileSync(
    join(dir, "tools", "many.mjs"),
    `export default async (_i, ctx) => {
      const codes = [];
      for (let i = 0; i < 30; i++) { try { const r = await ctx.capability("web.search", { query: "q" + i }); codes.push(r.status); } catch (e) { codes.push(e.code); } }
      return { codes };
    };`,
  );
  return dir;
}

describe("capability broker (sandbox → host)", () => {
  let root: string;
  let project: string;
  const calls: CapabilityRequest[] = [];
  const broker: CapabilityBroker = {
    async call(request) {
      calls.push(request);
      return { status: "LIVE", capability: request.capability, data: { echo: request.args }, provenance: { source: "test-broker", chain: "global", chainId: null, fetchedAt: "2026-10-02T00:00:00.000Z", fresh: true } };
    },
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-broker-"));
    project = join(root, "project");
    const p = (await SpliceProject.init(project)).project;
    const packages: Record<string, unknown> = {};
    for (const [id, src] of [["@splice/web", WEB_DIR], ["@acme/rogue", writeRogueSkill(root)]] as const) {
      const packed = await packDirectory(src);
      cpSync(src, p.packageDir(id), { recursive: true });
      // Installed with consent: the grant records the requested capabilities.
      packages[id] = { version: packed.manifest.version, integrity: packed.integrity, registry: "file:", resolved: "file:", permissions: packed.manifest.permissions };
    }
    await p.writeLock({ lockfileVersion: 1, packages: packages as never });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("runs a declared capability through the broker and returns its result unchanged", async () => {
    calls.length = 0;
    const splice = new Splice({ project, env: {}, broker });
    const r = await splice.run("web.search", { query: "robinhood chain", limit: 2 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.output as { status: string }).status, "LIVE");
    assert.deepEqual((r.output as { data: unknown }).data, { echo: { query: "robinhood chain", limit: 2 } });
    assert.deepEqual(calls.map((c) => [c.package, c.tool, c.capability]), [["@splice/web", "search", "web.search"]]);
    const skill = await splice.load("web");
    assert.equal(skill.tool("search")?.annotations.openWorldHint, true, "capabilities count as open world for MCP clients");
  });

  it("answers UNAVAILABLE (not an invented value) when no broker is attached", async () => {
    const r = await new Splice({ project, env: {}, broker: false }).run("web.answer", { question: "x" });
    assert.ok(r.ok);
    assert.equal((r.output as { status: string; code: string }).status, "UNAVAILABLE");
    assert.equal((r.output as { code: string }).code, "CAPABILITY_UNAVAILABLE");
  });

  it("refuses undeclared capabilities, also when the IPC channel is used directly", async () => {
    calls.length = 0;
    const splice = new Splice({ project, env: {}, broker });
    const undeclared = await splice.run("rogue.undeclared", {});
    assert.equal(undeclared.ok, false);
    assert.equal(!undeclared.ok && undeclared.error.code, "PERMISSION_DENIED");
    const forged = await splice.run("rogue.forge", {});
    assert.ok(forged.ok, JSON.stringify(forged));
    assert.equal((forged.output as { error: { code: string } }).error.code, "PERMISSION_DENIED");
    assert.deepEqual(calls, [], "the broker never saw an undeclared capability");
  });

  it("enforces the per-execution call budget", async () => {
    const r = await new Splice({ project, env: {}, broker }).run("rogue.many", {});
    assert.ok(r.ok, JSON.stringify(r));
    const codes = (r.output as { codes: string[] }).codes;
    assert.equal(codes.filter((c) => c === "LIVE").length, 25);
    assert.deepEqual([...new Set(codes.slice(25))], ["CAPABILITY_LIMIT"]);
  });

  it("refuses a package whose capabilities were not granted at install", async () => {
    const p = (await SpliceProject.require(project))!;
    const lock = await p.readLock();
    const saved = lock.packages["@splice/web"]!;
    lock.packages["@splice/web"] = { ...saved, permissions: { fs: { read: [], write: [] }, network: [], env: [], capabilities: ["web.search"] } };
    await p.writeLock(lock);
    try {
      await assert.rejects(new Splice({ project, env: {}, broker }).load("web"), (e: unknown) => {
        assert.ok(e instanceof CoreError && e.code === "PERMISSIONS_NOT_GRANTED");
        assert.ok(e.details.some((d) => d.startsWith("host capability: web.extract")), e.details.join("\n"));
        return true;
      });
    } finally {
      lock.packages["@splice/web"] = saved;
      await p.writeLock(lock);
    }
  });

  it("the real broker validates arguments and reports missing providers honestly (no network)", async () => {
    const data = new SpliceData({ env: {}, envFile: null, fetch: async () => assert.fail("no request may be made") });
    const real = createCapabilityBroker(data);
    const bad = (await real.call({ package: "@x/y", tool: "t", capability: "web.search", args: { query: "q", apiKey: "steal" } })) as { status: string; code: string };
    assert.deepEqual([bad.status, bad.code], ["ERROR", "INVALID_INPUT"]);
    const none = (await real.call({ package: "@x/y", tool: "t", capability: "web.search", args: { query: "q" } })) as { status: string };
    assert.equal(none.status, "UNAVAILABLE");
    const r = await new Splice({ project, env: {}, broker: real }).run("web.search", { query: "q" });
    assert.ok(r.ok);
    assert.equal((r.output as { status: string }).status, "UNAVAILABLE");
    assert.ok(!readFileSync(join(project, "splice.lock"), "utf8").includes("apiKey"));
  });
});
