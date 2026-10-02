import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeError, SpliceRuntime, type LoadedPackage } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(here, "../../../skills/example");

interface FixtureTool {
  name: string;
  source: string;
  input?: object;
  output?: object;
  timeoutMs?: number;
}

function writeFixture(root: string, name: string, tools: FixtureTool[], permissions: object = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace: "test",
      name,
      version: "1.0.0",
      description: "fixture",
      permissions,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.name,
        entry: `tools/${t.name}.ts`,
        input: t.input ?? { type: "object" },
        ...(t.output ? { output: t.output } : {}),
        ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
      })),
    }),
  );
  for (const t of tools) writeFileSync(join(dir, "tools", `${t.name}.ts`), t.source);
  return dir;
}

describe("runtime", () => {
  let project: string;
  let runtime: SpliceRuntime;

  before(() => {
    project = mkdtempSync(join(tmpdir(), "splice-runtime-"));
    writeFileSync(join(project, "secret.txt"), "top secret");
    mkdirSync(join(project, "notes"));
    writeFileSync(join(project, "notes", "a.txt"), "note a");
    runtime = new SpliceRuntime({ projectRoot: project, env: { SPLICE_TEST_TOKEN: "abc", OTHER_SECRET: "nope" } });
  });

  after(() => rmSync(project, { recursive: true, force: true }));

  describe("with the official example skill", () => {
    let pkg: LoadedPackage;
    before(async () => {
      pkg = await runtime.load(EXAMPLE_DIR);
    });

    it("loads and lists tools", () => {
      assert.equal(pkg.id, "@splice/example");
      assert.deepEqual(runtime.listTools(pkg).map((t) => t.name), ["hello", "stats"]);
    });

    it("executes hello with structured output", async () => {
      const result = await runtime.execute(pkg, "hello", { name: "Dim", excited: true });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.output, { message: "Hello, Dim!" });
    });

    it("matches the documented examples", async () => {
      for (const file of ["hello.json", "stats.json"]) {
        const example = JSON.parse(readFileSync(join(EXAMPLE_DIR, "examples", file), "utf8"));
        const result = await runtime.execute(pkg, example.tool, example.input);
        assert.ok(result.ok, JSON.stringify(result));
        assert.deepEqual(result.output, example.output);
      }
    });

    it("rejects invalid input before spawning", async () => {
      const result = await runtime.execute(pkg, "hello", { name: "", extra: 1 });
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, "INVALID_INPUT");
      assert.ok(!result.ok && result.error.details?.some((d) => d.includes("input.extra: unknown property")));
    });

    it("reports unknown tools", async () => {
      const result = await runtime.execute(pkg, "nope", {});
      assert.equal(!result.ok && result.error.code, "TOOL_NOT_FOUND");
    });
  });

  describe("sandbox", () => {
    let pkg: LoadedPackage;
    let permitted: LoadedPackage;

    before(async () => {
      pkg = await runtime.load(
        writeFixture(project, "sandboxed", [
          { name: "read-secret", source: `import { readFileSync } from "node:fs"; export default (_i, ctx) => ({ c: readFileSync(ctx.paths.project + "/secret.txt", "utf8") });` },
          { name: "spawn", source: `import { execSync } from "node:child_process"; export default () => ({ o: String(execSync("node -v")) });` },
          { name: "net", source: `export default async () => { await import("node:http"); return {}; };` },
          { name: "fetch", source: `export default async () => { await fetch("https://example.com"); return {}; };` },
          { name: "env", source: `export default () => ({ keys: Object.keys(process.env) });` },
          { name: "eval", source: `export default () => ({ v: eval("1 + 1") });` },
          { name: "loop", source: `export default () => { for (;;) {} };`, timeoutMs: 300 },
          { name: "throws", source: `export default () => { throw new Error("boom"); };` },
          { name: "no-default", source: `export const x = 1;` },
          { name: "bad-output", source: `export default () => ({ n: "not a number" });`, output: { type: "object", properties: { n: { type: "number" } } } },
          { name: "logs", source: `export default (_i, ctx) => { console.log("hello log"); ctx.log("ctx log"); return { ok: true }; };` },
          // Phase 8: ways around the resolve hook that used to work.
          { name: "builtin-net", source: `export default () => ({ t: typeof process.getBuiltinModule("node:net").connect });` },
          { name: "builtin-https", source: `export default () => ({ t: typeof process.getBuiltinModule("https").request });` },
          { name: "require-net", source: `import { createRequire } from "node:module"; export default () => ({ t: typeof createRequire(import.meta.url)("net") });` },
          { name: "hook-net", source: `import { registerHooks } from "node:module"; export default async () => { registerHooks({ resolve: (s, c, n) => (s === "node:net" ? { url: "node:net", shortCircuit: true } : n(s, c)) }); return { t: typeof (await import("node:net")).connect }; };` },
          { name: "builtin-module", source: `export default () => { const m = process.getBuiltinModule("module"); return { t: typeof m.registerHooks }; };` },
          { name: "undici", source: `export default () => ({ t: typeof globalThis[Symbol.for("undici.globalDispatcher.1")] });` },
          { name: "patch-guard", source: `export default () => { try { process.getBuiltinModule = () => ({}); } catch {} try { globalThis.fetch = () => "x"; } catch {} const p = fetch("http://x"); p.catch(() => {}); return { a: String(process.getBuiltinModule).includes("denied"), f: typeof p }; };` },
        ]),
      );
      permitted = await runtime.load(
        writeFixture(
          project,
          "permitted",
          [
            { name: "read-notes", source: `import { readFileSync } from "node:fs"; export default (_i, ctx) => ({ c: readFileSync(ctx.paths.project + "/notes/a.txt", "utf8") });` },
            { name: "read-secret", source: `import { readFileSync } from "node:fs"; export default (_i, ctx) => ({ c: readFileSync(ctx.paths.project + "/secret.txt", "utf8") });` },
            { name: "write-out", source: `import { writeFileSync } from "node:fs"; export default (_i, ctx) => { writeFileSync(ctx.paths.project + "/out/r.txt", "written"); return {}; };` },
            { name: "env", source: `export default () => ({ token: process.env.SPLICE_TEST_TOKEN ?? null, keys: Object.keys(process.env) });` },
          ],
          { fs: { read: ["notes"], write: ["out"] }, env: ["SPLICE_TEST_TOKEN"] },
        ),
      );
    });

    const expectError = async (target: () => LoadedPackage, tool: string, code: string) => {
      const result = await runtime.execute(target(), tool, {});
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(!result.ok && result.error.code, code, JSON.stringify(result));
      return result;
    };

    const fails = (tool: string, code: string) => async () => {
      await expectError(() => pkg, tool, code);
    };

    it("denies undeclared file reads", fails("read-secret", "PERMISSION_DENIED"));
    it("denies child processes", fails("spawn", "PERMISSION_DENIED"));
    it("denies raw network modules", fails("net", "PERMISSION_DENIED"));
    it("denies fetch to undeclared hosts", fails("fetch", "PERMISSION_DENIED"));
    it("denies network modules via process.getBuiltinModule", async () => {
      await expectError(() => pkg, "builtin-net", "PERMISSION_DENIED");
      await expectError(() => pkg, "builtin-https", "PERMISSION_DENIED");
      await expectError(() => pkg, "builtin-module", "PERMISSION_DENIED");
    });
    it("denies node:module (createRequire / registerHooks could re-open network modules)", async () => {
      await expectError(() => pkg, "require-net", "PERMISSION_DENIED");
      await expectError(() => pkg, "hook-net", "PERMISSION_DENIED");
    });
    it("hides the built-in fetch dispatcher and keeps the guard in place", async () => {
      const undici = await runtime.execute(pkg, "undici", {});
      assert.deepEqual(undici.ok && undici.output, { t: "undefined" });
      const patched = await runtime.execute(pkg, "patch-guard", {});
      assert.ok(patched.ok, JSON.stringify(patched));
      assert.deepEqual(patched.output, { a: true, f: "object" }, "getBuiltinModule is still the denying wrapper; fetch is still the guarded one (returns a promise)");
    });
    it("denies eval", fails("eval", "TOOL_ERROR"));
    it("enforces timeouts", fails("loop", "TIMEOUT"));
    it("reports thrown errors", async () => {
      const result = await expectError(() => pkg, "throws", "TOOL_ERROR");
      assert.equal(!result.ok && result.error.message, "boom");
    });
    it("requires a default export", fails("no-default", "TOOL_LOAD_FAILED"));
    it("validates output against the schema", fails("bad-output", "INVALID_OUTPUT"));

    it("exposes no environment variables by default", async () => {
      const result = await runtime.execute(pkg, "env", {});
      assert.ok(result.ok);
      assert.deepEqual(result.output, { keys: [] });
    });

    it("captures logs separately from output", async () => {
      const result = await runtime.execute(pkg, "logs", {});
      assert.ok(result.ok);
      assert.deepEqual(result.output, { ok: true });
      assert.match(result.logs, /hello log/);
      assert.match(result.logs, /ctx log/);
    });

    it("allows declared reads only", async () => {
      const ok = await runtime.execute(permitted, "read-notes", {});
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.deepEqual(ok.output, { c: "note a" });
      await expectError(() => permitted, "read-secret", "PERMISSION_DENIED");
    });

    it("allows declared writes", async () => {
      const result = await runtime.execute(permitted, "write-out", {});
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(readFileSync(join(project, "out", "r.txt"), "utf8"), "written");
    });

    it("passes only declared environment variables", async () => {
      const result = await runtime.execute(permitted, "env", {});
      assert.ok(result.ok);
      assert.deepEqual(result.output, { token: "abc", keys: ["SPLICE_TEST_TOKEN"] });
    });
  });

  describe("resource limits and secret hygiene (Phase 8)", () => {
    let leaky: LoadedPackage;
    let hygieneRuntime: SpliceRuntime;
    const secret = "s3cr3t-value-from-env-9f8e7d";

    before(async () => {
      hygieneRuntime = new SpliceRuntime({ projectRoot: project, env: { SERVICE_KEY: secret }, maxInputBytes: 64 * 1024 });
      leaky = await hygieneRuntime.load(
        writeFixture(
          project,
          "leaky",
          [
            { name: "echo-env", source: `export default () => { console.log("key is " + process.env.SERVICE_KEY); throw new Error("failed with " + process.env.SERVICE_KEY); };` },
            { name: "tokens", source: `export default () => { console.log("token splice_${"A".repeat(43)} and ghp_${"b".repeat(36)} Authorization: Bearer abcdefghijklmnop"); throw new Error("-----BEGIN RSA PRIVATE KEY-----\\nMIIEow\\n-----END RSA PRIVATE KEY----- at https://user:hunter22@example.com/?token=zzz"); };` },
            { name: "paths", source: `export default (_i, ctx) => { throw new Error("cannot open " + ctx.paths.package + "/x.ts in " + ctx.paths.project); };` },
            { name: "any", source: `export default (i) => ({ n: JSON.stringify(i).length });` },
          ],
          { env: ["SERVICE_KEY"] },
        ),
      );
    });

    it("refuses input nested deeper than the limit before validation", async () => {
      let deep: unknown = 1;
      for (let i = 0; i < 300; i++) deep = [deep];
      const result = await hygieneRuntime.execute(leaky, "any", { deep });
      assert.equal(!result.ok && result.error.code, "INPUT_TOO_LARGE");
      assert.ok((await hygieneRuntime.execute(leaky, "any", { ok: [[[1]]] })).ok);
    });

    it("refuses oversized input before spawning the tool", async () => {
      const started = Date.now();
      const result = await hygieneRuntime.execute(leaky, "any", { text: "x".repeat(70 * 1024) });
      assert.equal(!result.ok && result.error.code, "INPUT_TOO_LARGE");
      assert.match(!result.ok ? result.error.message : "", /bytes \(max 65536\)/);
      assert.ok(Date.now() - started < 200, "no process was spawned");
    });

    it("redacts environment values given to the tool from errors and logs", async () => {
      const result = await hygieneRuntime.execute(leaky, "echo-env", {});
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(secret), JSON.stringify(result));
      assert.match(!result.ok ? result.error.message : "", /failed with \[REDACTED\]/);
      assert.match(result.logs, /key is \[REDACTED\]/);
    });

    it("redacts well-known token formats, private keys and URL credentials", async () => {
      const result = await hygieneRuntime.execute(leaky, "tokens", {});
      const text = JSON.stringify(result);
      for (const leaked of ["AAAAAAAAAAAAAAAAAAAA", "bbbbbbbbbbbbbbbbbbbb", "abcdefghijklmnop", "MIIEow", "hunter22", "token=zzz"]) assert.ok(!text.includes(leaked), `${leaked} leaked: ${text}`);
    });

    it("replaces absolute package and project paths with placeholders", async () => {
      const result = await hygieneRuntime.execute(leaky, "paths", {});
      assert.equal(!result.ok && result.error.message, "cannot open <package>/x.ts in <project>");
    });
  });

  describe("invalid packages", () => {
    it("rejects a missing directory", async () => {
      await assert.rejects(runtime.load(join(project, "missing")), (e: unknown) => e instanceof RuntimeError && e.code === "INVALID_PACKAGE");
    });

    it("rejects an invalid manifest with details", async () => {
      const dir = join(project, "bad-manifest");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ specVersion: 1, name: "X" }));
      await assert.rejects(runtime.load(dir), (e: unknown) => e instanceof RuntimeError && e.details.length > 0);
    });

    it("rejects packages without SKILL.md or entry files", async () => {
      const dir = writeFixture(project, "incomplete", [{ name: "a", source: "export default () => ({})" }]);
      rmSync(join(dir, "SKILL.md"));
      rmSync(join(dir, "tools", "a.ts"));
      await assert.rejects(runtime.load(dir), (e: unknown) => {
        const details = (e as RuntimeError).details.join("\n");
        return /SKILL\.md is missing/.test(details) && /entry file "tools\/a\.ts" is missing/.test(details);
      });
    });
  });
});
