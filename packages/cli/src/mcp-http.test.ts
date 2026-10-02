/**
 * `splice mcp --http` transport: Streamable HTTP with mandatory bearer auth, exercised with the
 * official MCP SDK client (and raw requests for the security cases).
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SpliceProject, packDirectory } from "@spliceloom/core";
import { InstalledSkillsBackend, serveMcpHttp, type RunningMcpHttpServer } from "@spliceloom/mcp";
import { EXIT_USAGE, main } from "./index.js";

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/example");
const TOKEN = "test-mcp-token-0123456789abcdef";

describe("MCP over Streamable HTTP (splice mcp --http)", () => {
  let root: string;
  let projectRoot: string;
  let running: RunningMcpHttpServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-mcp-http-"));
    const { project } = await SpliceProject.init(join(root, "project"));
    projectRoot = project.root;
    const packed = await packDirectory(EXAMPLE_DIR);
    cpSync(EXAMPLE_DIR, project.packageDir("@splice/example"), { recursive: true });
    await project.writeLock({ lockfileVersion: 1, packages: { "@splice/example": { version: packed.manifest.version, integrity: packed.integrity, resolved: "file:" } } });
    running = await serveMcpHttp({ backend: new InstalledSkillsBackend({ projectRoot, serverVersion: "test" }), token: TOKEN, port: 0 });
  });

  after(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("works with the official MCP SDK client", async () => {
    const client = new Client({ name: "splice-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["splice_example_hello", "splice_example_stats"]);
      const hello = tools.find((t) => t.name === "splice_example_hello")!;
      assert.deepEqual(hello.inputSchema.required, ["name"]);
      const result = await client.callTool({ name: "splice_example_hello", arguments: { name: "Remote", excited: true } });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { message: "Hello, Remote!" });
      const invalid = await client.callTool({ name: "splice_example_hello", arguments: { name: 7 } });
      assert.equal(invalid.isError, true);
      const read = await client.readResource({ uri: "splice://packages/@splice/example/SKILL.md" });
      assert.match(String((read.contents[0] as { text: string }).text), /# @splice\/example/);
    } finally {
      await client.close();
    }
  });

  const post = (headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
    fetch(running.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

  it("fails closed without a valid bearer token", async () => {
    const none = await post({});
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await post({ authorization: "Bearer wrong-token-wrong-token-wrong" })).status, 401);
    assert.equal((await post({ authorization: `Basic ${TOKEN}` })).status, 401);
  });

  it("rejects cross-origin browser requests, non-POST methods and bad bodies", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await post({ ...auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(running.url, { headers: auth })).status, 405);
    assert.equal((await post({ ...auth, "content-type": "text/plain" })).status, 415);
    const parse = await fetch(running.url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{not json" });
    assert.equal(parse.status, 400);
    assert.equal(((await parse.json()) as { error: { code: number } }).error.code, -32700);
    assert.equal((await post({ ...auth, "mcp-protocol-version": "1999-01-01" })).status, 400);
    const notification = await post(auth, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notification.status, 202);
    assert.equal((await fetch(running.url.replace("/mcp", "/other"), { headers: auth })).status, 404);
  });

  it("refuses to start without a strong token", async () => {
    await assert.rejects(serveMcpHttp({ backend: new InstalledSkillsBackend({ projectRoot, serverVersion: "t" }), token: "short", port: 0 }), /at least 24/);
    let stderr = "";
    const code = await main(["mcp", "--http", "--project", projectRoot], {
      stdout: () => {},
      stderr: (t) => (stderr += t),
      cwd: root,
      env: { SPLICE_HOME: join(root, "home") },
      color: false,
    });
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /SPLICE_MCP_TOKEN/);
  });
});
