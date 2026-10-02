/**
 * Stable tool contract derived from a manifest. The SDK, the local/remote MCP servers and the
 * registry's MCP endpoint all describe tools through this one function, so names and schemas are
 * always the package's real definitions.
 */
import { DEFAULT_TOOL_TIMEOUT_MS, manifestId, type Manifest } from "./manifest.js";
import type { Permissions } from "./permissions.js";
import type { JsonSchema } from "./schema.js";

/** MCP clients commonly limit tool names to ^[a-zA-Z0-9_-]{1,64}$. */
export const MAX_MCP_TOOL_NAME = 64;

export interface ToolAnnotations {
  /** No declared file writes. */
  readOnlyHint: boolean;
  /** Declares file writes. */
  destructiveHint: boolean;
  /** Declares network hosts. */
  openWorldHint: boolean;
}

export interface ToolDescriptor {
  /** Package id, e.g. `@splice/example`. */
  package: string;
  version: string;
  /** Tool name inside the package, e.g. `hello`. */
  tool: string;
  /** Short reference used by `splice run`, e.g. `example.hello`. */
  name: string;
  /** Fully qualified reference, e.g. `@splice/example.hello`. */
  qualifiedName: string;
  /** MCP tool name, e.g. `splice_example_hello` (segments never contain `_`, so it is unambiguous). */
  mcpName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permissions: Permissions;
  annotations: ToolAnnotations;
  timeoutMs: number;
}

export function mcpToolName(namespace: string, name: string, tool: string): string {
  return `${namespace}_${name}_${tool}`;
}

export function toolAnnotations(permissions: Permissions): ToolAnnotations {
  const readOnly = permissions.fs.write.length === 0;
  // Host capabilities reach external data too (through the broker), so they count as open world.
  return { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: permissions.network.length > 0 || (permissions.capabilities?.length ?? 0) > 0 };
}

/** Describes every tool of a (validated) manifest. */
export function describeTools(manifest: Manifest): ToolDescriptor[] {
  const id = manifestId(manifest);
  return manifest.tools.map((t) => {
    const descriptor: ToolDescriptor = {
      package: id,
      version: manifest.version,
      tool: t.name,
      name: `${manifest.name}.${t.name}`,
      qualifiedName: `${id}.${t.name}`,
      mcpName: mcpToolName(manifest.namespace, manifest.name, t.name),
      description: t.description,
      inputSchema: t.input,
      permissions: manifest.permissions,
      annotations: toolAnnotations(manifest.permissions),
      timeoutMs: t.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    };
    if (t.output) descriptor.outputSchema = t.output;
    return descriptor;
  });
}
