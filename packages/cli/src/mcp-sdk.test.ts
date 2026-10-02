/**
 * Compatibility test: the official MCP TypeScript SDK client launches `splice mcp` over stdio,
 * lists and calls tools and reads resources. The SDK validates responses (including
 * structuredContent against outputSchema), so this checks protocol conformance end to end.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SpliceProject, packDirectory } from "@spliceloom/core";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "bin.js");
const EXAMPLE_DIR = resolve(here, "../../../skills/example");

describe("splice mcp with the official MCP SDK client", () => {
  let root: string;
  let client: Client;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-mcp-sdk-"));
    const { project } = await SpliceProject.init(join(root, "project"));
    const packed = await packDirectory(EXAMPLE_DIR);
    cpSync(EXAMPLE_DIR, project.packageDir("@splice/example"), { recursive: true });
    await project.writeLock({
      lockfileVersion: 1,
      packages: { "@splice/example": { version: packed.manifest.version, integrity: packed.integrity, resolved: "file:" } },
    });

    // Launched from an unrelated cwd, like an MCP client would; --project selects the project.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", "--project", project.root],
      cwd: root,
      stderr: "pipe",
    });
    client = new Client({ name: "splice-test", version: "1.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes with a supported protocol version", () => {
    assert.equal(client.getServerVersion()?.name, "splice");
    assert.ok(client.getServerCapabilities()?.tools);
  });

  it("lists tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["splice_example_hello", "splice_example_stats"]);
  });

  it("calls a tool and returns validated structured content", async () => {
    const result = await client.callTool({ name: "splice_example_stats", arguments: { text: "a bb\nccc" } });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { characters: 8, words: 3, lines: 2, longestWord: "ccc" });
  });

  it("reports invalid input as a tool error", async () => {
    const result = await client.callTool({ name: "splice_example_hello", arguments: {} });
    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /INVALID_INPUT/);
  });

  it("reads SKILL.md resources", async () => {
    const { resources } = await client.listResources();
    assert.equal(resources[0]?.uri, "splice://packages/@splice/example/SKILL.md");
    const read = await client.readResource({ uri: resources[0]!.uri });
    assert.match(String((read.contents[0] as { text: string }).text), /# @splice\/example/);
  });
});
