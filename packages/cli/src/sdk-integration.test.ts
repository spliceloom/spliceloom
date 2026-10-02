/**
 * SDK against a real registry over HTTP (local Node registry): search/info/resolve/add/load/run,
 * tool discovery, publish, security failures (fail closed), sandbox enforcement, and the example
 * agent (examples/agent/agent.ts) executed as a separate process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { packDirectory } from "@spliceloom/core";
import type { RegistryService } from "@spliceloom/registry";
import { openLocalRegistry, serveRegistry, type RunningServer } from "@spliceloom/registry/node";
import { CoreError, Splice } from "@spliceloom/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const EXAMPLE_DIR = join(REPO, "skills", "example");

function writeSkill(root: string, name: string, tools: Array<{ name: string; source: string; input?: object }>, extra: object = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace: "acme",
      name,
      version: "1.0.0",
      description: `${name} fixture`,
      tools: tools.map((t) => ({ name: t.name, description: t.name, entry: `tools/${t.name}.ts`, input: t.input ?? { type: "object" } })),
      ...extra,
    }),
  );
  for (const t of tools) writeFileSync(join(dir, "tools", `${t.name}.ts`), t.source);
  return dir;
}

describe("sdk integration (real registry over HTTP)", () => {
  let root: string;
  let service: RegistryService;
  let server: RunningServer;
  let acmeToken: string;
  let otherToken: string;
  const env = () => ({ SPLICE_HOME: join(root, "home") });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-sdk-int-"));
    service = openLocalRegistry(join(root, "registry"));
    const splice = await service.createUser("splice");
    await service.setNamespaceOwner("splice", "splice");
    await service.publish((await packDirectory(EXAMPLE_DIR)).bytes, splice);
    await service.createUser("acme");
    await service.createUser("other");
    acmeToken = (await service.createToken("acme")).token;
    otherToken = (await service.createToken("other")).token;
    server = await serveRegistry({ service, port: 0 });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const sdk = (project: string, extra: Partial<ConstructorParameters<typeof Splice>[0]> = {}) =>
    new Splice({ project, registry: server.url, env: env(), ...extra });

  it("searches, inspects and resolves packages", async () => {
    const splice = sdk(join(root, "p1"));
    assert.deepEqual((await splice.search("example")).map((r) => r.name), ["@splice/example"]);
    const info = await splice.info("@splice/example");
    assert.equal(info.version.version, "0.1.1");
    assert.deepEqual(info.tools.map((t) => t.name), ["example.hello", "example.stats"]);
    assert.deepEqual(info.tools[0]!.inputSchema, info.version.manifest.tools[0]!.input, "schemas come from the published manifest");
    assert.deepEqual(await splice.resolve("@splice/example@^0.1.0"), { id: "@splice/example", version: "0.1.1" });
    await assert.rejects(splice.resolve("@splice/example@^9.0.0"), (e: unknown) => e instanceof CoreError && e.code === "NO_MATCHING_VERSION");
    await assert.rejects(splice.info("@splice/nope"), (e: unknown) => e instanceof CoreError && e.code === "PACKAGE_NOT_FOUND");
  });

  it("installs, discovers, executes and removes", async () => {
    const splice = sdk(join(root, "p2"));
    assert.deepEqual(await splice.init(), { root: join(root, "p2"), created: true });
    const added = await splice.add("@splice/example");
    assert.match(added.integrity, /^sha256-[0-9a-f]{64}$/);
    assert.deepEqual((await splice.list()).map((p) => [p.id, p.version, p.status]), [["@splice/example", "0.1.1", "ok"]]);
    assert.deepEqual((await splice.tools()).map((t) => t.mcpName), ["splice_example_hello", "splice_example_stats"]);
    const skill = await splice.load("@splice/example");
    const result = await skill.run("example.stats", { text: "a bb\nccc" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.output, { characters: 8, words: 3, lines: 2, longestWord: "ccc" });
    const invalid = await skill.run("hello", {});
    assert.equal(!invalid.ok && invalid.error.code, "INVALID_INPUT");
    assert.deepEqual(await splice.remove("@splice/example"), { id: "@splice/example", version: "0.1.1" });
    await assert.rejects(splice.load("example"), (e: unknown) => e instanceof CoreError && e.code === "NOT_INSTALLED");
  });

  it("publishes with a token and fails closed without one", async () => {
    const skillDir = writeSkill(join(root, "skills"), "echo", [{ name: "echo", source: "export default (i) => ({ echoed: i })" }]);
    const project = join(root, "p3");
    await assert.rejects(sdk(project).publish(skillDir), (e: unknown) => e instanceof CoreError && e.code === "NOT_LOGGED_IN");
    await assert.rejects(sdk(project, { token: "splice_invalid-token" }).publish(skillDir), (e: unknown) => e instanceof CoreError && e.code === "UNAUTHENTICATED");
    const published = await sdk(project, { token: acmeToken }).publish(skillDir);
    assert.equal(published.response?.name, "@acme/echo");
    // Another user may not publish into @acme.
    const intruder = writeSkill(join(root, "skills2"), "echo", [{ name: "echo", source: "export default () => ({})" }], { version: "2.0.0" });
    await assert.rejects(sdk(project, { token: otherToken }).publish(intruder), (e: unknown) => e instanceof CoreError && e.code === "FORBIDDEN");
    assert.equal((await sdk(project, { token: acmeToken }).whoami()).user, "acme");
    await assert.rejects(sdk(project, { token: "garbage" }).whoami(), (e: unknown) => e instanceof CoreError && e.code === "UNAUTHENTICATED");
  });

  it("rejects invalid packages", async () => {
    const broken = join(root, "skills", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "manifest.json"), JSON.stringify({ specVersion: 1, namespace: "acme", name: "broken" }));
    await assert.rejects(sdk(join(root, "p4"), { token: acmeToken }).publish(broken), (e: unknown) => e instanceof CoreError && e.code === "INVALID_PACKAGE");
  });

  it("enforces the sandbox, permissions, runtime requirements and reports runtime failures", async () => {
    const risky = writeSkill(join(root, "skills"), "risky", [
      { name: "read-secret", source: `import { readFileSync } from "node:fs"; export default (_i, ctx) => ({ c: readFileSync(ctx.paths.project + "/secret.txt", "utf8") });` },
      { name: "spawn", source: `import { execSync } from "node:child_process"; export default () => ({ o: String(execSync("node -v")) });` },
      { name: "fetch", source: `export default async () => { await fetch("https://example.com"); return {}; };` },
      { name: "crash", source: `export default () => { throw new Error("tool exploded"); };` },
    ]);
    const future = writeSkill(join(root, "skills"), "future", [{ name: "run", source: "export default () => ({})" }], { runtime: { type: "node", minNodeVersion: "999.0.0" } });
    const publisher = sdk(join(root, "p5"), { token: acmeToken });
    await publisher.publish(risky);
    await publisher.publish(future);

    const project = join(root, "p6");
    const splice = sdk(project);
    await splice.init();
    writeFileSync(join(project, "secret.txt"), "top secret");
    await splice.add("@acme/risky");
    await splice.add("@acme/future");
    const skill = await splice.load("risky");
    const code = async (tool: string) => {
      const r = await skill.run(tool, {});
      return r.ok ? "ok" : r.error.code;
    };
    assert.equal(await code("read-secret"), "PERMISSION_DENIED");
    assert.equal(await code("spawn"), "PERMISSION_DENIED");
    assert.equal(await code("fetch"), "PERMISSION_DENIED");
    const crash = await skill.run("crash", {});
    assert.equal(!crash.ok && crash.error.code, "TOOL_ERROR");
    assert.equal(!crash.ok && crash.error.message, "tool exploded");
    const unsupported = await (await splice.load("future")).run("run", {});
    assert.equal(!unsupported.ok && unsupported.error.code, "RUNTIME_UNSUPPORTED");
  });

  it("verifies packages through the SDK with structured results", async () => {
    const project = join(root, "p-verify");
    const splice = sdk(project);
    await splice.init();
    const report = await splice.verify("@splice/example");
    assert.equal(report.verified, true, JSON.stringify(report.checks));
    assert.equal(report.package, "@splice/example");
    assert.equal(report.publisher, "splice");
    assert.equal(report.checks.find((c) => c.id === "provenance")?.status, "passed");
    assert.equal(report.checks.find((c) => c.id === "installed")?.status, "skipped");
    await splice.add("@splice/example");
    assert.equal((await splice.verify("@splice/example")).checks.find((c) => c.id === "installed")?.status, "passed");
    await assert.rejects(splice.verify("@splice/nope"), (e: unknown) => e instanceof CoreError && e.code === "PACKAGE_NOT_FOUND");
  });

  it("requires explicit consent for packages that request permissions", async () => {
    const net = writeSkill(join(root, "skills"), "netty", [{ name: "ping", source: "export default () => ({})" }], { permissions: { network: ["api.example.com"] } });
    await sdk(join(root, "p7"), { token: acmeToken }).publish(net);
    const project = join(root, "p8");
    const splice = sdk(project);
    await splice.init();
    await assert.rejects(splice.add("@acme/netty"), (e: unknown) => e instanceof CoreError && e.code === "PERMISSIONS_NOT_ACCEPTED");
    assert.deepEqual(await splice.list(), []);
    await splice.add("@acme/netty", { acceptPermissions: true });
    assert.equal((await splice.load("netty")).manifest.permissions.network[0], "api.example.com");
  });

  it("runs the example agent end to end (separate process)", async () => {
    const agentDir = join(root, "agent-project");
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [join(REPO, "examples", "agent", "agent.ts"), "count the words in: Splice composes capabilities"], {
        cwd: REPO,
        env: { ...process.env, SPLICE_REGISTRY: server.url, SPLICE_AGENT_DIR: agentDir, SPLICE_HOME: join(root, "agent-home") },
        timeout: 60_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (c) => resolvePromise({ code: c, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stdout + out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.tool, "@splice/example.stats");
    assert.deepEqual(result.discovered, ["example.hello", "example.stats"]);
    assert.deepEqual(result.output, { characters: 28, words: 3, lines: 1, longestWord: "capabilities" });
  });
});
