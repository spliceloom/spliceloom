/**
 * Remote MCP backend of the registry Worker (`/mcp`, Streamable HTTP, bearer token required).
 *
 * Discovery only: agents can search the registry, inspect packages with the real tool schemas from
 * the published manifests, and read SKILL.md. The Worker never executes skill code — it has no
 * sandbox. Execution happens where the Splice runtime runs (`splice mcp`, `splice mcp --http`, SDK).
 */
import { McpError, jsonToolResult, type McpBackend, type McpResourceContents, type McpTool, type McpToolCallResult } from "@spliceloom/mcp/protocol";
import { JSONRPC_INVALID_PARAMS } from "@spliceloom/mcp/protocol";
import { SKILL_DOC_FILE, decodePackageArchive, describeTools, maxSatisfying, parsePackageRef, type ToolDescriptor } from "@spliceloom/spec";
import { RegistryError, type AuthUser, type RegistryService } from "./service.js";

const TEMPLATE = "splice://registry/{namespace}/{name}/{version}/SKILL.md";
const TEMPLATE_PATTERN = /^splice:\/\/registry\/([a-z0-9-]+)\/([a-z0-9-]+)\/([0-9A-Za-z.+-]+|latest)\/SKILL\.md$/;

function publicTool(t: ToolDescriptor): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    name: t.name,
    qualifiedName: t.qualifiedName,
    mcpName: t.mcpName,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  };
  if (t.outputSchema) tool.outputSchema = t.outputSchema;
  return tool;
}

export class RegistryMcpBackend implements McpBackend {
  readonly info: McpBackend["info"];

  constructor(
    private readonly service: RegistryService,
    readonly user: AuthUser,
    version: string,
  ) {
    this.info = {
      name: "splice-registry",
      title: "Splice Registry",
      version,
      instructions:
        "Discover Splice skills: search the registry and inspect packages (tool names, input/output schemas, permissions). This server does not execute skills; install them with `splice add` and run them through `splice mcp` or the Splice SDK.",
    };
  }

  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: "registry_search",
        title: "Search Splice packages",
        description: "Search the Splice registry by package name and description.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 100, description: "Search text" },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, description: { type: "string" }, latest: { type: "string" } },
                required: ["name", "description", "latest"],
              },
            },
          },
          required: ["query", "results"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "registry_package_info",
        title: "Inspect a Splice package",
        description:
          "Metadata of a package version: description, versions, integrity, permissions and every tool with its input/output JSON Schema taken from the published manifest.",
        inputSchema: {
          type: "object",
          properties: {
            package: { type: "string", minLength: 3, maxLength: 140, description: "Package id, e.g. @splice/example" },
            version: { type: "string", maxLength: 64, description: "Version or range (default: latest)" },
          },
          required: ["package"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            description: { type: "string" },
            latest: { type: "string" },
            versions: { type: "array", items: { type: "string" } },
            integrity: { type: "string" },
            publishedAt: { type: "string" },
            permissions: { type: "object" },
            tools: { type: "array", items: { type: "object" } },
            skillDoc: { type: "string" },
          },
          required: ["name", "version", "description", "latest", "versions", "integrity", "permissions", "tools", "skillDoc"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ];
  }

  private async resolve(pkgInput: string, range?: string): Promise<{ id: string; version: string; latest: string; versions: string[] }> {
    let ref;
    try {
      ref = parsePackageRef(range ? `${pkgInput}@${range}` : pkgInput);
    } catch (error) {
      throw new McpError(JSONRPC_INVALID_PARAMS, (error as Error).message);
    }
    const pkg = await this.service.getPackage(ref.id);
    const versions = pkg.versions.map((v) => v.version);
    const version = maxSatisfying(versions, ref.range);
    if (!version) throw new RegistryError("NOT_FOUND", 404, `No version of ${ref.id} matches "${ref.range}"`);
    return { id: ref.id, version, latest: pkg.latest, versions };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult | undefined> {
    try {
      if (name === "registry_search") {
        const query = args.query;
        const limit = args.limit ?? 10;
        if (typeof query !== "string" || query.length === 0 || query.length > 100) throw new McpError(JSONRPC_INVALID_PARAMS, "query must be a string of 1-100 characters");
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new McpError(JSONRPC_INVALID_PARAMS, "limit must be an integer between 1 and 50");
        return jsonToolResult(await this.service.search(query, limit));
      }
      if (name === "registry_package_info") {
        if (typeof args.package !== "string") throw new McpError(JSONRPC_INVALID_PARAMS, "package must be a string");
        if (args.version !== undefined && typeof args.version !== "string") throw new McpError(JSONRPC_INVALID_PARAMS, "version must be a string");
        const target = await this.resolve(args.package, args.version as string | undefined);
        const detail = await this.service.getVersion(target.id, target.version);
        const [namespace, pkgName] = target.id.slice(1).split("/");
        return jsonToolResult({
          name: target.id,
          version: detail.version,
          description: detail.manifest.description,
          latest: target.latest,
          versions: target.versions,
          integrity: detail.integrity,
          publishedAt: detail.publishedAt,
          permissions: detail.manifest.permissions,
          tools: describeTools(detail.manifest).map(publicTool),
          skillDoc: `splice://registry/${namespace}/${pkgName}/${detail.version}/SKILL.md`,
        });
      }
      return undefined;
    } catch (error) {
      // Registry errors (unknown package, …) are tool errors the agent can react to.
      if (error instanceof RegistryError) return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
      throw error;
    }
  }

  async listResourceTemplates() {
    return [{ uriTemplate: TEMPLATE, name: "Package SKILL.md", description: "Documentation of a published package version (version may be 'latest').", mimeType: "text/markdown" }];
  }

  async readResource(uri: string): Promise<McpResourceContents | undefined> {
    const match = TEMPLATE_PATTERN.exec(uri);
    if (!match) return undefined;
    const id = `@${match[1]}/${match[2]}`;
    try {
      const version = match[3] === "latest" ? (await this.service.getPackage(id)).latest : match[3]!;
      const artifact = await this.service.getArtifact(id, version);
      const doc = (await decodePackageArchive(artifact.bytes)).find((f) => f.path === SKILL_DOC_FILE);
      if (!doc) return undefined;
      return { contents: [{ uri, mimeType: "text/markdown", text: new TextDecoder().decode(doc.content) }] };
    } catch (error) {
      if (error instanceof RegistryError && error.status === 404) return undefined;
      throw error;
    }
  }
}
