import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildInput, coerceValue } from "./commands/run.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main, VERSION } from "./index.js";

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/example");
// Never touch the real ~/.splice from tests.
const HOME = mkdtempSync(join(tmpdir(), "splice-cli-home-"));

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd,
    env: { SPLICE_HOME: HOME, ...env },
    color: false,
  });
  return { code, stdout, stderr };
}

describe("cli", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "splice-cli-"));
  });
  after(() => rmSync(HOME, { recursive: true, force: true }));

  describe("registry configuration and auth (offline)", () => {
    it("sets, reads and unsets the user registry with aliases", async () => {
      assert.match((await run(["config", "get", "registry"], dir)).stdout, /^https:\/\/registry\.spliceloom\.com \(default\)/);
      assert.equal((await run(["config", "set", "registry", "local"], dir)).code, EXIT_OK);
      assert.match((await run(["config", "get", "registry"], dir)).stdout, /^http:\/\/127\.0\.0\.1:8787 \(user\)/);
      assert.match((await run(["config", "get", "registry"], dir, { SPLICE_REGISTRY: "http://env.test" })).stdout, /^http:\/\/env\.test \(env\)/);
      assert.match((await run(["config", "get", "registry", "--registry", "production"], dir)).stdout, /registry\.spliceloom\.com \(flag\)/);
      assert.equal((await run(["config", "unset", "registry"], dir)).code, EXIT_OK);
      assert.match((await run(["config", "get", "registry"], dir)).stdout, /\(default\)/);
      assert.equal((await run(["config", "set", "registry", "ftp://x"], dir)).code, EXIT_USAGE);
      assert.equal((await run(["config", "set", "colour", "x"], dir)).code, EXIT_USAGE);
    });

    it("validates a package with publish --dry-run without a network", async () => {
      const result = await run(["publish", EXAMPLE_DIR, "--dry-run", "--registry", "http://127.0.0.1:9"], dir);
      assert.equal(result.code, EXIT_OK, result.stderr);
      assert.match(result.stdout, /Dry run: @splice\/example@0\.1\.1 is valid/);
    });

    it("requires login before publishing or whoami", async () => {
      const publish = await run(["publish", EXAMPLE_DIR, "--registry", "http://127.0.0.1:9"], dir);
      assert.equal(publish.code, EXIT_FAILURE);
      assert.match(publish.stderr, /Not logged in/);
      assert.match(publish.stderr, /splice login/);
      const whoami = await run(["whoami", "--registry", "http://127.0.0.1:9"], dir);
      assert.equal(whoami.code, EXIT_FAILURE);
      assert.match(whoami.stderr, /Not logged in/);
      const login = await run(["login", "--registry", "http://127.0.0.1:9"], dir);
      assert.equal(login.code, EXIT_USAGE);
      assert.equal((await run(["logout", "--registry", "http://127.0.0.1:9"], dir)).stdout.trim(), "Not logged in to http://127.0.0.1:9");
    });

    it("validates token, namespace and mcp arguments before touching the network", async () => {
      const offline = ["--registry", "http://127.0.0.1:9"];
      for (const argv of [
        ["token"],
        ["token", "frob"],
        ["token", "create", "--expires", "0"],
        ["token", "create", "--expires", "400d"],
        ["token", "revoke"],
        ["namespace"],
        ["namespace", "info", "Bad!"],
        ["namespace", "add-maintainer", "@dim"],
        ["mcp", "extra"],
        ["token", "list", "--project", "x"],
        ["verify"],
        ["verify", "not-a-package"],
        ["verify", "@splice/example", "extra"],
        ["verify", "@splice/example", "--accept-permissions"],
      ]) {
        const result = await run([...argv, ...offline], dir);
        assert.equal(result.code, EXIT_USAGE, `${argv.join(" ")} → ${result.code}\n${result.stderr}`);
      }
      const notLoggedIn = await run(["token", "list", ...offline], dir);
      assert.equal(notLoggedIn.code, EXIT_FAILURE);
      assert.match(notLoggedIn.stderr, /Not logged in/);
    });

    it("refuses to start the MCP server outside a project", async () => {
      const { PassThrough } = await import("node:stream");
      let stderr = "";
      const code = await main(["mcp", "--project", dir], {
        stdout: () => {},
        stderr: (t) => (stderr += t),
        cwd: dir,
        env: { SPLICE_HOME: HOME },
        color: false,
        stdin: new PassThrough(),
      });
      assert.equal(code, EXIT_FAILURE);
      assert.match(stderr, /No splice\.json found/);
    });

    it("rejects invalid publish directories", async () => {
      const result = await run(["publish", dir, "--dry-run"], dir);
      assert.equal(result.code, EXIT_FAILURE);
      assert.match(result.stderr, /manifest\.json is missing/);
    });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  describe("help and usage", () => {
    it("prints help and version", async () => {
      const help = await run(["--help"], dir);
      assert.equal(help.code, EXIT_OK);
      for (const cmd of ["init", "search", "info", "add", "remove", "list", "run"]) assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
      const cmdHelp = await run(["run", "--help"], dir);
      assert.match(cmdHelp.stdout, /Usage: splice run <package>\.<tool>/);
      assert.equal((await run(["help", "add"], dir)).stdout.includes("Usage: splice add"), true);
      const version = await run(["--version"], dir);
      assert.equal(version.stdout.trim(), VERSION);
    });

    it("exits with 2 on usage errors", async () => {
      const cases: string[][] = [
        [],
        ["frobnicate"],
        ["list", "--bogus"],
        ["list", "--input", "{}"],
        ["search"],
        ["search", "x", "--limit", "0"],
        ["add"],
        ["add", "not-a-package"],
        ["add", "@splice/example@banana"],
        ["run"],
        ["run", "noTool"],
        ["search", "x", "--registry", "ftp://nope"],
      ];
      for (const argv of cases) {
        const result = await run(argv, dir);
        assert.equal(result.code, EXIT_USAGE, `${argv.join(" ")} → ${result.code}\n${result.stderr}`);
        assert.ok(result.stderr.length > 0, argv.join(" "));
      }
    });

    it("explains how to recover when not in a project", async () => {
      const result = await run(["list"], dir);
      assert.equal(result.code, EXIT_FAILURE);
      assert.match(result.stderr, /No splice\.json found/);
      assert.match(result.stderr, /splice init/);
    });

    it("reports an unreachable registry", async () => {
      const result = await run(["search", "x", "--registry", "http://127.0.0.1:9"], dir);
      assert.equal(result.code, EXIT_FAILURE);
      assert.match(result.stderr, /Could not reach the registry/);
    });

    it("initializes idempotently", async () => {
      const project = join(dir, "proj");
      const first = await run(["init", project], dir);
      assert.equal(first.code, EXIT_OK);
      assert.match(first.stdout, /Initialized Splice project/);
      const second = await run(["init", project], dir);
      assert.equal(second.code, EXIT_OK);
      assert.match(second.stdout, /Already a Splice project/);
      const list = await run(["list"], project);
      assert.equal(list.code, EXIT_OK);
      assert.match(list.stdout, /No packages installed/);
    });
  });

  describe("live data commands without provider keys (offline)", () => {
    it("lists Robinhood Chain as the default chain", async () => {
      const r = await run(["chain", "list", "--json"], dir);
      assert.equal(r.code, EXIT_OK);
      const chains = JSON.parse(r.stdout) as Array<{ key: string; chainId: number; default?: boolean }>;
      assert.deepEqual(chains.map((c) => [c.key, c.chainId]), [["robinhood", 4663]]);
    });

    it("reports UNAVAILABLE (exit 3) instead of inventing data when no provider is configured", async () => {
      // Offline test: the keyless public RPC is switched off, so no provider can answer.
      const block = await run(["block", "latest"], dir, { ROBINHOOD_PUBLIC_RPC_URL: "off" });
      assert.equal(block.code, 3, block.stdout + block.stderr);
      assert.match(block.stdout, /UNAVAILABLE/);
      assert.match(block.stdout, /ALCHEMY_RPC_URL or ALCHEMY_API_KEY is not set/);
      assert.match(block.stdout, /hint: run `splice setup`/);

      const portfolio = await run(["wallet", "portfolio", "0x948951006b81b5dc954a18b639918a768447a66f", "--json"], dir);
      assert.equal(portfolio.code, 3);
      const parsed = JSON.parse(portfolio.stdout) as Record<string, unknown>;
      assert.equal(parsed.status, "UNAVAILABLE");
      assert.equal(parsed.code, "CAPABILITY_UNAVAILABLE");
      assert.equal("data" in parsed, false);
      assert.match(String(parsed.timestamp), /^\d{4}-/);
    });

    it("setup explains what works without keys and prints a template without values", async () => {
      const r = await run(["setup", "--json"], dir);
      assert.equal(r.code, EXIT_OK, r.stderr);
      const guide = JSON.parse(r.stdout) as { features: Array<{ feature: string; withoutKeys: string | null; keys: Array<{ env: string[]; set: boolean }> }> };
      assert.match(guide.features.find((f) => f.feature.startsWith("Robinhood"))!.withoutKeys ?? "", /public RPC/);
      assert.equal(guide.features.find((f) => f.feature.startsWith("Wallet"))!.withoutKeys, null);
      assert.ok(guide.features.flatMap((f) => f.keys).every((k) => k.set === false), "no keys in this test environment");
      const t = await run(["setup", "--template"], dir, { OPENROUTER_API_KEY: "sk-or-v1-should-never-appear" });
      assert.match(t.stdout, /^OPENROUTER_API_KEY=$/m);
      assert.match(t.stdout, /^GOPLUS_APP_SECRET=$/m);
      assert.doesNotMatch(t.stdout, /should-never-appear/);
    });

    it("setup --init writes ~/.splice/.env once and keys there are used from any directory", async () => {
      const home = join(dir, "user-home");
      const first = await run(["setup", "--init", "--json"], dir, { SPLICE_HOME: home });
      assert.equal(first.code, EXIT_OK, first.stderr);
      const file = join(home, ".env");
      assert.deepEqual(JSON.parse(first.stdout), { file, created: true });
      assert.match(readFileSync(file, "utf8"), /^CODEX_API_KEY=$/m);
      writeFileSync(file, "FRED_API_KEY=user-level-fred-key\n");
      const again = await run(["setup", "--init", "--json"], dir, { SPLICE_HOME: home });
      assert.equal(JSON.parse(again.stdout).created, false);
      assert.equal(readFileSync(file, "utf8"), "FRED_API_KEY=user-level-fred-key\n", "never overwritten");
      const status = JSON.parse((await run(["setup", "--json"], dir, { SPLICE_HOME: home })).stdout) as { envFile: string; features: Array<{ keys: Array<{ env: string[]; set: boolean }> }> };
      assert.equal(status.envFile, file);
      assert.ok(status.features.flatMap((f) => f.keys).some((k) => k.env.includes("FRED_API_KEY") && k.set));
    });

    it("lists AI, GitHub and market providers with their configuration state, without requests", async () => {
      const r = await run(["provider", "list", "--json"], dir);
      assert.equal(r.code, EXIT_OK, r.stderr);
      const rows = JSON.parse(r.stdout) as Array<{ provider: string; configured: boolean; status: string }>;
      const by = (n: string) => rows.find((x) => x.provider === n)!;
      assert.equal(by("openrouter").configured, false);
      assert.equal(by("openrouter").status, "not_configured");
      assert.equal(by("gemini").status, "not_configured");
      assert.equal(by("github-public").configured, true);
      assert.equal(by("dexscreener").configured, true);
      assert.equal(by("geckoterminal").configured, true);
      assert.equal(by("github-raw").configured, true);
      for (const web of ["tavily", "exa", "firecrawl"]) assert.equal(by(web).status, "not_configured", web);
    });

    it("AI without a key is UNAVAILABLE (exit 3); invalid raw URLs and networks are usage errors", async () => {
      const ai = await run(["ai", "generate", "hello", "--model", "openai/gpt-4o-mini", "--json"], dir);
      assert.equal(ai.code, 3, ai.stdout + ai.stderr);
      assert.equal(JSON.parse(ai.stdout).status, "UNAVAILABLE");
      const raw = await run(["github", "raw", "https://example.com/o/r/main/a.txt"], dir);
      assert.equal(raw.code, EXIT_USAGE, raw.stdout + raw.stderr);
      const net = await run(["market", "pairs", "../x", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"], dir);
      assert.equal(net.code, EXIT_USAGE);
      assert.equal((await run(["provider", "nope"], dir)).code, EXIT_USAGE);
      const local = await run(["web", "extract", "http://127.0.0.1:8080/admin"], dir);
      assert.equal(local.code, EXIT_USAGE, local.stdout + local.stderr);
      assert.match(local.stdout + local.stderr, /not a public web URL/);
      const web = await run(["web", "search", "robinhood chain", "--json"], dir);
      assert.equal(web.code, 3, "no web key configured: UNAVAILABLE");
    });

    it("rejects invalid input with a usage-style exit code and no request", async () => {
      const r = await run(["wallet", "balances", "0x1234"], dir);
      assert.equal(r.code, EXIT_USAGE, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /INVALID_INPUT/);
      assert.equal((await run(["chain", "info", "ethereum"], dir)).code, EXIT_USAGE);
    });
  });

  describe("run input", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        count: { type: "integer" as const },
        on: { type: "boolean" as const },
      },
    };

    it("coerces values using the schema", () => {
      assert.equal(coerceValue("123", { type: "string" }), "123");
      assert.equal(coerceValue("12", { type: "integer" }), 12);
      assert.equal(coerceValue("abc", { type: "number" }), "abc");
      assert.equal(coerceValue("true", { type: "boolean" }), true);
      assert.deepEqual(coerceValue("[1,2]", undefined), [1, 2]);
      assert.equal(coerceValue("plain", undefined), "plain");
    });

    it("merges --input with key=value pairs", () => {
      assert.deepEqual(buildInput(["count=3", "name=a=b"], '{"on":true,"name":"x"}', schema), { on: true, name: "a=b", count: 3 });
      assert.throws(() => buildInput(["novalue"], undefined, schema), /Expected key=value/);
      assert.throws(() => buildInput([], "[1]", schema), /must be a JSON object/);
      assert.throws(() => buildInput([], "{bad", schema), /not valid JSON/);
    });
  });
});
