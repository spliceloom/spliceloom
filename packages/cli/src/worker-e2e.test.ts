/**
 * End-to-end against the real Cloudflare Worker running locally in workerd (wrangler's official
 * test harness) with emulated D1 + R2 — no Cloudflare account or credentials needed.
 *
 *   create package → login → publish → search → info → add → list → run → remove
 *
 * plus authentication, namespace permissions, duplicate versions, malicious archives and
 * artifact storage checks. Requires `npm run build` (which also produces apps/registry/dist-worker).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { computeIntegrity, encodeBundle, type VersionResponse } from "@spliceloom/spec";
import { packDirectory } from "@spliceloom/core";
import { FakeGitHub } from "@spliceloom/registry/testing";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "bin.js");
const REGISTRY_APP = resolve(here, "../../../apps/registry");
const ADMIN = "splice_admin_worker-e2e";
const GITHUB_TOKEN = "github_pat_fake_for_tests_only";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Harness {
  listen(): Promise<{ url: URL }>;
  getWorker(): { applyD1Migrations(binding: string): Promise<void>; getEnv(): Promise<Record<string, any>> };
  close(): Promise<void>;
}

function writeGreeter(root: string, version: string): string {
  const dir = join(root, `greeter-${version}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# @dim/greeter\n\nGreets people.\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace: "dim",
      name: "greeter",
      version,
      description: "Friendly greetings for agents",
      permissions: {},
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          entry: "tools/greet.ts",
          input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
          output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
    }),
  );
  writeFileSync(join(dir, "tools", "greet.ts"), `export default (input: { name: string }) => ({ text: "Hi " + input.name + " from ${version}" });\n`);
  return dir;
}

describe("worker e2e: publish → search → info → add → list → run → remove (D1 + R2 emulated)", () => {
  let harness: Harness;
  let url: string;
  let root: string;
  let project: string;
  let home: string;
  let dimToken: string;
  let malloryToken: string;
  let greeterDir: string;
  let github: FakeGitHub;
  let githubServer: { url: string; close: () => Promise<void> };

  const splice = (args: string[], options: { stdin?: string; cwd?: string; token?: string } = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: options.cwd ?? project,
        env: { ...process.env, SPLICE_REGISTRY: url, SPLICE_HOME: home, SPLICE_TOKEN: options.token ?? "", NO_COLOR: "1" },
        timeout: 60_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.end(options.stdin ?? "");
    });

  const admin = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${url}${path}`, init);
    assert.ok(res.ok, `${method} ${path} → ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as Record<string, string>;
  };

  before(async () => {
    process.env.WRANGLER_SEND_METRICS = "false";
    // Production config (D1 + GitHub Releases), with the GitHub API pointed at a local fake.
    github = new FakeGitHub("spliceloom", "splice-artifacts", GITHUB_TOKEN);
    githubServer = await github.listen();
    const { createTestHarness } = (await import("wrangler")) as unknown as { createTestHarness: (o: unknown) => Harness };
    harness = createTestHarness({
      root: REGISTRY_APP,
      workers: [
        {
          configPath: "./wrangler.toml",
          prebuiltWorkerDir: "./dist-worker",
          vars: { GITHUB_API_URL: githubServer.url, GITHUB_UPLOAD_URL: githubServer.url },
          secrets: { ADMIN_TOKEN_SHA256: await sha256Hex(ADMIN), GITHUB_TOKEN: GITHUB_TOKEN },
        },
      ],
    });
    url = (await harness.listen()).url.href.replace(/\/$/, "");
    await harness.getWorker().applyD1Migrations("DB");

    await admin("POST", "/admin/users", { name: "dim" });
    await admin("POST", "/admin/users", { name: "mallory" });
    // @dim is a reserved name: an admin assigns it.
    await admin("PUT", "/admin/namespaces/dim", { owner: "dim" });
    dimToken = (await admin("POST", "/admin/users/dim/tokens", { label: "e2e" })).token!;
    malloryToken = (await admin("POST", "/admin/users/mallory/tokens", {})).token!;

    root = mkdtempSync(join(tmpdir(), "splice-worker-e2e-"));
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(project);
    greeterDir = writeGreeter(root, "1.0.0");
  });

  after(async () => {
    await harness?.close();
    await githubServer?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a bad token at login and stores a good one privately", async () => {
    const bad = await splice(["login"], { stdin: "splice_definitely-not-valid\n" });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /rejected this token/);

    const good = await splice(["login"], { stdin: `${dimToken}\n` });
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, new RegExp(`Logged in to ${url.replace(/[.:/]/g, "\\$&")} as dim`));
    assert.ok(!good.stdout.includes(dimToken) && !good.stderr.includes(dimToken), "token must never be printed");
    const creds = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"));
    assert.equal(creds.registries[url].user, "dim");

    const who = await splice(["whoami"]);
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /^dim on /);
  });

  it("publishes a new package and claims the namespace", async () => {
    const r = await splice(["publish", greeterDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Validating/);
    assert.match(r.stderr, /Packaging @dim\/greeter@1\.0\.0/);
    assert.match(r.stdout, /Published @dim\/greeter@1\.0\.0/);
    assert.match((await splice(["whoami"])).stdout, /owns:\s+@dim/);
  });

  it("stores the artifact as a GitHub release asset, metadata in D1, nothing in KV", async () => {
    const env = await harness.getWorker().getEnv();
    const version = (await (await fetch(`${url}/packages/dim/greeter/1.0.0`)).json()) as VersionResponse;
    const row = await env.DB.prepare("SELECT artifact_key, artifact_backend, artifact_url FROM versions WHERE package_id = ?").bind("@dim/greeter").first();
    assert.equal(row.artifact_key, `packages/dim/greeter/1.0.0/${version.integrity.slice(7)}.tar.gz`);
    assert.equal(row.artifact_backend, "github-releases");
    assert.equal(version.artifact?.url, row.artifact_url);
    assert.equal(version.artifact?.filename, "dim-greeter-1.0.0.tar.gz");

    const asset = github.assets.find((a) => a.name === "dim-greeter-1.0.0.tar.gz");
    assert.ok(asset, "artifact missing from GitHub");
    assert.equal(asset.digest, `sha256:${version.integrity.slice(7)}`);
    assert.equal(await computeIntegrity(asset.bytes), version.integrity);
    assert.deepEqual(github.releases.map((r) => r.tag_name), ["pkg/dim/greeter"]);
    assert.equal(env.ARTIFACTS_KV, undefined, "production config binds no KV");
    assert.equal(env.ARTIFACTS, undefined, "production config binds no R2");

    // The public asset URL recorded in D1 serves the same verified bytes.
    const direct = new Uint8Array(await (await fetch(version.artifact!.url!)).arrayBuffer());
    assert.equal(await computeIntegrity(direct), version.integrity);

    const tokens = await env.DB.prepare("SELECT * FROM tokens").all();
    const dump = JSON.stringify(tokens.results);
    assert.ok(!dump.includes(dimToken) && !dump.includes(malloryToken));
    assert.ok(dump.includes(await sha256Hex(dimToken)));
    const versions = JSON.stringify((await env.DB.prepare("SELECT * FROM versions").all()).results);
    assert.ok(!versions.includes(GITHUB_TOKEN), "the GitHub token never reaches D1");
  });

  it("does not register a version when the GitHub upload fails, and a retry succeeds", async () => {
    github.failures = [{ match: "/assets?name=", status: 500 }];
    const dir = writeGreeter(join(root, "gh-fail"), "0.9.0");
    const failed = await splice(["publish", dir]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /could not be stored/);
    assert.ok(!failed.stderr.includes(GITHUB_TOKEN));
    assert.equal((await fetch(`${url}/packages/dim/greeter/0.9.0`)).status, 404);
    assert.equal((await splice(["publish", dir])).code, 0);
  });

  it("rejects a corrupted artifact on install and installs nothing", async () => {
    const asset = github.assets.find((a) => a.name === "dim-greeter-0.9.0.tar.gz")!;
    const original = asset.bytes;
    const corrupted = new Uint8Array(original);
    corrupted[corrupted.length - 20] = corrupted[corrupted.length - 20]! ^ 0xff;
    asset.bytes = corrupted;
    const corruptProject = join(root, "corrupt-project");
    mkdirSync(corruptProject);
    await splice(["init"], { cwd: corruptProject });
    const add = await splice(["add", "@dim/greeter@0.9.0"], { cwd: corruptProject });
    assert.equal(add.code, 1);
    assert.match(add.stderr, /Integrity check failed/);
    assert.match((await splice(["list"], { cwd: corruptProject })).stdout, /No packages installed/);
    asset.bytes = original;
  });

  it("rejects duplicate versions", async () => {
    const r = await splice(["publish", greeterDir]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already published/);
  });

  it("enforces namespace permissions and reserved namespaces", async () => {
    const other = writeGreeter(join(root, "mallory"), "2.0.0");
    const r = await splice(["publish", other], { cwd: root });
    assert.equal(r.code, 0, "sanity: dim can publish 2.0.0");

    const res = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${malloryToken}` },
      body: (await packDirectory(writeGreeter(join(root, "m2"), "3.0.0"))).bytes as Uint8Array<ArrayBuffer>,
    });
    assert.equal(res.status, 403);

    const exampleDir = resolve(here, "../../../skills/example");
    const reserved = await splice(["publish", exampleDir]);
    assert.equal(reserved.code, 1);
    assert.match(reserved.stderr, /reserved/);

    const anonymous = await fetch(`${url}/publish`, { method: "POST", body: "{}" });
    assert.equal(anonymous.status, 401);
  });

  it("rejects malicious archives", async () => {
    const good = await packDirectory(writeGreeter(join(root, "evil"), "9.0.0"));
    const traversal = new TextEncoder().encode(
      new TextDecoder().decode(encodeBundle(good.files)).replace('"path":"SKILL.md"', '"path":"../../../SKILL.md"'),
    );
    const res = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${dimToken}` },
      body: traversal as Uint8Array<ArrayBuffer>,
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "INVALID_PACKAGE");
    assert.equal((await fetch(`${url}/packages/dim/greeter/9.0.0`)).status, 404);
  });

  it("searches and inspects the remote package", async () => {
    const search = await splice(["search", "greet"]);
    assert.equal(search.code, 0, search.stderr);
    assert.match(search.stdout, /^@dim\/greeter\nFriendly greetings for agents\nlatest: 2\.0\.0\n$/);
    const info = await splice(["info", "@dim/greeter@1.0.0"]);
    assert.equal(info.code, 0, info.stderr);
    assert.match(info.stdout, /@dim\/greeter 1\.0\.0/);
    assert.match(info.stdout, /greeter\.greet/);
  });

  it("installs from the remote registry, runs through the runtime and removes", async () => {
    assert.equal((await splice(["init"])).code, 0);
    const add = await splice(["add", "@dim/greeter@^1.0.0"]);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /Installed @dim\/greeter@1\.0\.0/);
    const lock = JSON.parse(readFileSync(join(project, "splice.lock"), "utf8"));
    assert.equal(lock.packages["@dim/greeter"].resolved, `${url}/packages/dim/greeter/1.0.0/download`);
    assert.equal(lock.packages["@dim/greeter"].registry, url);

    // 2.0.0 exists but is outside ^1.0.0: nothing to update within the range.
    const outdated = JSON.parse((await splice(["outdated", "--json"])).stdout);
    assert.deepEqual(outdated, [{ id: "@dim/greeter", range: "^1.0.0", current: "1.0.0", wanted: "1.0.0", latest: "2.0.0", status: "up-to-date" }]);
    const update = await splice(["update"]);
    assert.equal(update.code, 0, update.stderr);
    assert.match(update.stdout, /@dim\/greeter@1\.0\.0 is up to date/);
    assert.match(update.stdout, /@dim\/greeter@2\.0\.0 is outside "\^1\.0\.0"/);

    assert.equal((await splice(["list"])).stdout.trim(), "@dim/greeter  1.0.0");

    const run = await splice(["run", "greeter.greet", "name=Dim"]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { text: "Hi Dim from 1.0.0" });

    const upgrade = await splice(["add", "@dim/greeter"]);
    assert.match(upgrade.stdout, /Installed @dim\/greeter@2\.0\.0 \(was 1\.0\.0\)/);

    const remove = await splice(["remove", "@dim/greeter"]);
    assert.equal(remove.code, 0, remove.stderr);
    assert.match((await splice(["list"])).stdout, /No packages installed/);
  });

  it("creates a scoped CI token and publishes with it via SPLICE_TOKEN", async () => {
    const created = await splice(["token", "create", "--label", "ci", "--namespace", "@dim", "--expires", "30d"]);
    assert.equal(created.code, 0, created.stderr);
    const ciToken = created.stdout.trim();
    assert.match(ciToken, /^splice_[A-Za-z0-9_-]{43}$/);
    assert.match(created.stderr, /publish-only, @dim, expires/);

    const publish = await splice(["publish", writeGreeter(join(root, "ci"), "2.1.0")], { token: ciToken });
    assert.equal(publish.code, 0, publish.stderr);
    const denied = await splice(["token", "list"], { token: ciToken });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /publish-only/);

    const list = await splice(["token", "list"]);
    assert.match(list.stdout, /ci\n\s+publish-only, @dim/);
    const id = /^(\S+)\s+active\s+ci$/m.exec(list.stdout)?.[1];
    assert.ok(id, list.stdout);
    assert.equal((await splice(["token", "revoke", id!])).code, 0);
    assert.equal((await splice(["whoami"], { token: ciToken })).code, 1);
  });

  it("adds and removes namespace maintainers", async () => {
    const added = await splice(["namespace", "add-maintainer", "@dim", "mallory"]);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /maintainers:\s+mallory/);
    const res = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${malloryToken}` },
      body: (await packDirectory(writeGreeter(join(root, "maint"), "2.2.0"))).bytes as Uint8Array<ArrayBuffer>,
    });
    assert.equal(res.status, 201, "maintainer can publish");
    const info = await splice(["namespace", "info", "@dim"]);
    assert.match(info.stdout, /owner:\s+dim/);
    assert.match(info.stdout, /packages:\s+@dim\/greeter/);
    assert.equal((await splice(["namespace", "remove-maintainer", "@dim", "mallory"])).code, 0);
    assert.match((await splice(["namespace", "info", "@dim"])).stdout, /maintainers:\s+none/);
  });

  it("verifies a published version with `splice verify` and detects a tampered GitHub asset", async () => {
    const ok = await splice(["verify", "@dim/greeter@1.0.0"]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /@dim\/greeter@1\.0\.0\s+VERIFIED/);
    assert.match(ok.stdout, /publisher:\s+dim/);
    assert.match(ok.stdout, /provenance:\s+recorded at publish/);
    assert.match(ok.stdout, /\[pass\] sha256/);
    assert.match(ok.stdout, /\[pass\] metadata/);
    assert.match(ok.stdout, /\[skip\] signature\s+unsigned/);
    assert.match(ok.stdout, /not who wrote the package/);
    const json = JSON.parse((await splice(["verify", "@dim/greeter@1.0.0", "--json"])).stdout);
    assert.equal(json.verified, true);
    assert.equal(json.provenance.publisher.user, "dim");

    const provenance = (await (await fetch(`${url}/packages/dim/greeter/1.0.0/provenance`)).json()) as { provenance: { recorded: boolean; artifact: { integrity: string } } };
    assert.equal(provenance.provenance.recorded, true);

    // Someone with access to the release swaps the bytes: verification must fail, not install.
    const asset = github.assets.find((a) => a.name === "dim-greeter-1.0.0.tar.gz")!;
    const original = asset.bytes;
    const swapped = new Uint8Array(original);
    swapped[swapped.length - 40] = swapped[swapped.length - 40]! ^ 0xff;
    asset.bytes = swapped;
    try {
      const bad = await splice(["verify", "@dim/greeter@1.0.0"]);
      assert.equal(bad.code, 1);
      assert.match(bad.stdout, /FAILED/);
      assert.match(bad.stdout, /\[FAIL\] sha256/);
    } finally {
      asset.bytes = original;
    }
  });

  it("serves remote MCP discovery at /mcp with explicit token auth (official SDK client)", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "worker-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${dimToken}` } } }));
    try {
      assert.equal(client.getServerVersion()?.name, "splice-registry");
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["registry_search", "registry_package_info"]);

      const search = await client.callTool({ name: "registry_search", arguments: { query: "greet" } });
      assert.deepEqual((search.structuredContent as { results: Array<{ name: string }> }).results.map((r) => r.name), ["@dim/greeter"]);

      const info = await client.callTool({ name: "registry_package_info", arguments: { package: "@dim/greeter", version: "1.0.0" } });
      const body = info.structuredContent as { version: string; tools: Array<Record<string, unknown>>; skillDoc: string };
      assert.equal(body.version, "1.0.0");
      const manifest = ((await (await fetch(`${url}/packages/dim/greeter/1.0.0`)).json()) as VersionResponse).manifest;
      assert.deepEqual(body.tools[0]!.inputSchema, manifest.tools[0]!.input, "schemas are the published manifest's");
      assert.deepEqual(body.tools[0]!.outputSchema, manifest.tools[0]!.output);
      assert.equal(body.tools[0]!.mcpName, "dim_greeter_greet");

      const doc = await client.readResource({ uri: body.skillDoc });
      assert.match(String((doc.contents[0] as { text: string }).text), /# @dim\/greeter/);
      const latestDoc = await client.readResource({ uri: "splice://registry/dim/greeter/latest/SKILL.md" });
      assert.match(String((latestDoc.contents[0] as { text: string }).text), /Greets people/);

      const unknown = await client.callTool({ name: "registry_package_info", arguments: { package: "@dim/nope" } });
      assert.equal(unknown.isError, true);
      await assert.rejects(client.callTool({ name: "registry_search", arguments: { query: "" } }));
      await assert.rejects(client.callTool({ name: "splice_example_hello", arguments: {} }), /Unknown tool/);
    } finally {
      await client.close();
    }

    const rpc = (headers: Record<string, string>) =>
      fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal((await rpc({})).status, 401, "unauthenticated requests fail closed");
    assert.equal((await rpc({ authorization: "Bearer splice_not-a-valid-token" })).status, 401, "invalid tokens fail closed");
  });

  it("logs out", async () => {
    assert.match((await splice(["logout"])).stdout, /Logged out of/);
    assert.equal((await splice(["whoami"])).code, 1);
  });
});

describe("worker with R2 artifact storage (wrangler.r2.toml)", () => {
  let harness: Harness;
  let url: string;
  let root: string;

  before(async () => {
    process.env.WRANGLER_SEND_METRICS = "false";
    const { createTestHarness } = (await import("wrangler")) as unknown as { createTestHarness: (o: unknown) => Harness };
    harness = createTestHarness({
      root: REGISTRY_APP,
      workers: [{ configPath: "./wrangler.r2.toml", secrets: { ADMIN_TOKEN_SHA256: await sha256Hex(ADMIN) } }],
    });
    url = (await harness.listen()).url.href.replace(/\/$/, "");
    await harness.getWorker().applyD1Migrations("DB");
    root = mkdtempSync(join(tmpdir(), "splice-worker-r2-"));
  });

  after(async () => {
    await harness?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("publishes into R2 and serves the same bytes", async () => {
    const auth = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    assert.equal((await fetch(`${url}/admin/users`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dim" }) })).status, 201);
    // @dim is a reserved name: an admin assigns it.
    assert.equal((await fetch(`${url}/admin/namespaces/dim`, { method: "PUT", headers: auth, body: JSON.stringify({ owner: "dim" }) })).status, 200);
    const token = ((await (await fetch(`${url}/admin/users/dim/tokens`, { method: "POST", headers: auth, body: "{}" })).json()) as { token: string }).token;

    const packed = await packDirectory(writeGreeter(root, "1.0.0"));
    const published = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: packed.bytes as Uint8Array<ArrayBuffer>,
    });
    assert.equal(published.status, 201, await published.clone().text());

    const env = await harness.getWorker().getEnv();
    const object = await env.ARTIFACTS.get(`packages/dim/greeter/1.0.0/${packed.integrity.slice(7)}.tar.gz`);
    assert.ok(object, "artifact missing from R2");
    const download = await fetch(`${url}/packages/dim/greeter/1.0.0/download`);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), packed.bytes);
    assert.equal(download.headers.get("x-splice-integrity"), packed.integrity);

    // wrangler.r2.toml allows 2 publishes per minute: the third is rejected by the D1-backed limiter.
    const again = async (version: string) =>
      fetch(`${url}/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: (await packDirectory(writeGreeter(join(root, version), version))).bytes as Uint8Array<ArrayBuffer>,
      });
    assert.equal((await again("1.0.1")).status, 201);
    const limited = await again("1.0.2");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");

    // 3 failed authentications (AUTH_FAILURES_PER_10_MINUTES = 3) block the client.
    const whoami = (t: string) => fetch(`${url}/auth/whoami`, { headers: { authorization: `Bearer ${t}` } });
    for (let i = 0; i < 3; i++) assert.equal((await whoami("splice_wrong-token")).status, 401);
    assert.equal((await whoami(token)).status, 429);
  });
});
