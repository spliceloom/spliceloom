import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceProject, packDirectory } from "@spliceloom/core";
import { SpliceMcpServer, serveStdio, type JsonRpcResponse } from "./index.js";

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/example");

/** Installs a skill directory into a project without a registry (test helper). */
export async function installLocal(project: SpliceProject, dir: string): Promise<void> {
  const packed = await packDirectory(dir);
  const id = `@${packed.manifest.namespace}/${packed.manifest.name}`;
  cpSync(dir, project.packageDir(id), { recursive: true });
  const lock = await project.readLock();
  lock.packages[id] = { version: packed.manifest.version, integrity: packed.integrity, resolved: `file:${dir}` };
  await project.writeLock(lock);
}

function writeWriterSkill(root: string): string {
  const dir = join(root, "writer");
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# writer");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      specVersion: 1,
      namespace: "acme",
      name: "writer",
      version: "1.0.0",
      description: "Writes notes",
      permissions: { fs: { write: ["out"] }, network: ["api.example.com"] },
      tools: [
        { name: "save", description: "Save", entry: "tools/save.ts", input: { type: "object" }, output: { type: "string" } },
        { name: "list", description: "List", entry: "tools/list.ts", input: { type: "object" } },
      ],
    }),
  );
  writeFileSync(join(dir, "tools", "save.ts"), `export default () => "saved";`);
  writeFileSync(join(dir, "tools", "list.ts"), `export default () => [1, 2];`);
  return dir;
}

describe("mcp server", () => {
  let root: string;
  let server: SpliceMcpServer;
  let nextId = 1;

  const request = async (method: string, params?: unknown): Promise<JsonRpcResponse> => {
    const response = await server.handle({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
    assert.ok(response, `no response for ${method}`);
    return response;
  };
  const result = async <T = Record<string, any>>(method: string, params?: unknown): Promise<T> => {
    const response = await request(method, params);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result as T;
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-mcp-"));
    const { project } = await SpliceProject.init(join(root, "project"));
    await installLocal(project, EXAMPLE_DIR);
    await installLocal(project, writeWriterSkill(root));
    server = new SpliceMcpServer({ projectRoot: project.root, serverVersion: "0.0.0-test" });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("negotiates the protocol version", async () => {
    const init = await result("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.deepEqual(init.capabilities, { tools: { listChanged: false }, resources: { listChanged: false } });
    assert.equal(init.serverInfo.name, "splice");
    const unknown = await result("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(unknown.protocolVersion, "2025-11-25");
  });

  it("lists installed tools with schemas and permission-derived annotations", async () => {
    const { tools } = await result<{ tools: Array<Record<string, any>> }>("tools/list");
    assert.deepEqual(tools.map((t) => t.name), ["acme_writer_save", "acme_writer_list", "splice_example_hello", "splice_example_stats"]);
    const hello = tools.find((t) => t.name === "splice_example_hello")!;
    assert.equal(hello.title, "@splice/example.hello");
    assert.deepEqual(hello.inputSchema.required, ["name"]);
    assert.equal(hello.outputSchema.type, "object");
    assert.deepEqual(hello.annotations, { title: "@splice/example.hello", readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const save = tools.find((t) => t.name === "acme_writer_save")!;
    assert.equal(save.outputSchema, undefined, "non-object output schemas are not exposed");
    assert.deepEqual(save.annotations, { title: "@acme/writer.save", readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("calls tools through the sandbox with structured results", async () => {
    const ok = await result("tools/call", { name: "splice_example_hello", arguments: { name: "Dim", excited: true } });
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.structuredContent, { message: "Hello, Dim!" });
    assert.deepEqual(JSON.parse(ok.content[0].text), { message: "Hello, Dim!" });

    const list = await result("tools/call", { name: "acme_writer_list", arguments: {} });
    assert.equal(list.structuredContent, undefined, "arrays are returned as text only");
    assert.deepEqual(JSON.parse(list.content[0].text), [1, 2]);
  });

  it("reports tool failures as isError results, not protocol errors", async () => {
    const bad = await result("tools/call", { name: "splice_example_hello", arguments: { nope: 1 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^INVALID_INPUT/);
    assert.match(bad.content[0].text, /input\.name: is required/);
  });

  it("returns protocol errors for unknown tools, methods and bad params", async () => {
    assert.equal((await request("tools/call", { name: "nope_nope_nope", arguments: {} })).error?.code, -32602);
    assert.equal((await request("tools/call", { arguments: {} })).error?.code, -32602);
    assert.equal((await request("tools/call", { name: "splice_example_hello", arguments: [] })).error?.code, -32602);
    assert.equal((await request("prompts/list")).error?.code, -32601);
    assert.deepEqual(await result("ping"), {});
  });

  it("serves SKILL.md resources and only listed URIs", async () => {
    const { resources } = await result<{ resources: Array<Record<string, string>> }>("resources/list");
    assert.deepEqual(resources.map((r) => r.uri), ["splice://packages/@acme/writer/SKILL.md", "splice://packages/@splice/example/SKILL.md"]);
    const read = await result("resources/read", { uri: "splice://packages/@splice/example/SKILL.md" });
    assert.match(read.contents[0].text, /^# @splice\/example/);
    assert.equal(read.contents[0].mimeType, "text/markdown");
    const traversal = await request("resources/read", { uri: "splice://packages/@splice/example/../../../../etc/passwd" });
    assert.equal(traversal.error?.code, -32002);
  });

  it("omits 2025-06-18 features for older clients", async () => {
    await result("initialize", { protocolVersion: "2024-11-05" });
    const { tools } = await result<{ tools: Array<Record<string, any>> }>("tools/list");
    assert.ok(tools.every((t) => t.outputSchema === undefined));
    const ok = await result("tools/call", { name: "splice_example_hello", arguments: { name: "x" } });
    assert.equal(ok.structuredContent, undefined);
    await result("initialize", { protocolVersion: "2025-11-25" });
  });

  it("ignores notifications and rejects malformed messages", async () => {
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.equal((await server.handle([1, 2]))?.error?.code, -32600);
    assert.equal((await server.handle({ jsonrpc: "1.0", id: 9, method: "ping" }))?.error?.code, -32600);
  });

  it("speaks newline-delimited JSON-RPC over stdio", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveStdio(server, input, (line) => lines.push(line));
    input.write(String.fromCharCode(0xfeff) + '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write("not json\n");
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await done;
    const messages = lines.map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n")));
    assert.deepEqual(messages.find((m) => m.id === 1), { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(messages.find((m) => m.id === null)?.error.code, -32700);
    assert.equal(messages.find((m) => m.id === 2)?.result.tools.length, 4);
    assert.equal(messages.length, 3);
  });

  it("drops oversized stdio messages while streaming and keeps serving (Phase 8)", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveStdio(server, input, (line) => lines.push(line), { maxLineLength: 1000 });
    // An oversized line arriving in chunks, without a newline for a long time.
    for (let i = 0; i < 20; i++) input.write("x".repeat(200));
    input.write("\n");
    input.write(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"splice_example_hello","arguments":{"name":"${"y".repeat(1200)}"}}}\n`);
    input.end('{"jsonrpc":"2.0","id":8,"method":"ping"}\r\n');
    await done;
    const messages = lines.map((l) => JSON.parse(l));
    assert.deepEqual(messages.filter((m) => m.id === null).map((m) => m.error.message), ["Message too large", "Message too large"]);
    assert.deepEqual(messages.find((m) => m.id === 8), { jsonrpc: "2.0", id: 8, result: {} });
    assert.equal(messages.some((m) => m.id === 7), false, "the oversized request was never executed");
  });
});
