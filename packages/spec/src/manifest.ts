import type { ValidationResult } from "./errors.js";
import { formatPackageId, isValidNameSegment, isValidToolName } from "./names.js";
import { isSafeRelativePath, normalizePermissions, type Permissions } from "./permissions.js";
import { checkSchemaDefinition, type JsonSchema } from "./schema.js";
import { isValidRange, isValidVersion } from "./semver.js";

/** Current manifest specification version. */
export const SPEC_VERSION = 1;
export const SUPPORTED_SPEC_VERSIONS: readonly number[] = [1];

export const MANIFEST_FILE = "manifest.json";
export const SKILL_DOC_FILE = "SKILL.md";
export const TOOL_ENTRY_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const MAX_TOOL_TIMEOUT_MS = 60_000;

export interface ToolDefinition {
  /** Tool name, unique within the package. Invoked as `<package>.<tool>`. */
  name: string;
  description: string;
  /** Package-relative path to an ES module whose default export implements the tool. */
  entry: string;
  /** JSON Schema (Splice subset) for the input object. */
  input: JsonSchema;
  /** Optional JSON Schema for the output; validated by the runtime when present. */
  output?: JsonSchema;
  /** Execution time limit in milliseconds. */
  timeoutMs?: number;
}

export interface RuntimeInfo {
  /** Spec v1 supports a single runtime: sandboxed Node.js ES modules. */
  type: "node";
  /** Optional minimum Node.js version the tools need (e.g. "22.18.0"). Added in Phase 4; optional. */
  minNodeVersion?: string;
}

export const MAX_AGENT_INSTRUCTIONS = 8000;
export const MAX_AGENT_SKILLS = 20;
export const MAX_AGENT_EXAMPLES = 6;

/**
 * An agent: instructions plus the skills whose tools it may call. The package that declares it
 * needs no tools of its own. The agent holds no keys and gets no permissions: every tool call
 * runs in the sandbox of the skill that owns the tool, under that skill's own permissions.
 */
export interface AgentDefinition {
  /** The agent's system instructions (plain text). */
  instructions: string;
  /** Packages (`@namespace/name`) whose tools the agent may call. They must be installed to run it. */
  skills: string[];
  /** Preferred model id; the host may use another one. */
  model?: string;
  /** Example prompts, shown on the agent's page. */
  examples?: string[];
}

export interface Manifest {
  specVersion: 1;
  namespace: string;
  name: string;
  version: string;
  description: string;
  license?: string;
  homepage?: string;
  runtime: RuntimeInfo;
  permissions: Permissions;
  tools: ToolDefinition[];
  /** Present on agent packages; `tools` may then be empty. */
  agent?: AgentDefinition;
  /** Reserved for future dependency support; see validateDependencies. */
  dependencies?: Record<string, string>;
}

const AGENT_KEYS = new Set(["instructions", "skills", "model", "examples"]);

function validateAgent(raw: unknown, selfId: string, errors: string[]): AgentDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push("agent: must be an object");
    return undefined;
  }
  for (const key of Object.keys(raw)) if (!AGENT_KEYS.has(key) && !isExtensionKey(key)) errors.push(`agent.${key}: unknown field`);
  const instructions = requireString(raw, "instructions", "agent.", errors, MAX_AGENT_INSTRUCTIONS);
  const skills: string[] = [];
  if (!Array.isArray(raw.skills)) errors.push("agent.skills: must be an array of package ids (it may be empty)");
  else {
    if (raw.skills.length > MAX_AGENT_SKILLS) errors.push(`agent.skills: at most ${MAX_AGENT_SKILLS} packages`);
    for (const id of raw.skills) {
      const match = typeof id === "string" ? /^@([^/]+)\/([^/]+)$/.exec(id) : null;
      if (!match || !isValidNameSegment(match[1]!) || !isValidNameSegment(match[2]!)) errors.push(`agent.skills: invalid package name ${JSON.stringify(id)}`);
      else if (id === selfId) errors.push(`agent.skills: an agent cannot list itself (${selfId})`);
      else if (skills.includes(id as string)) errors.push(`agent.skills: duplicate package "${id}"`);
      else skills.push(id as string);
    }
  }
  const agent: AgentDefinition = { instructions, skills };
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim().length === 0 || raw.model.length > 100) errors.push("agent.model: must be a non-empty string of at most 100 characters");
    else agent.model = raw.model;
  }
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples) || raw.examples.length > MAX_AGENT_EXAMPLES || !raw.examples.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 300)) {
      errors.push(`agent.examples: must be at most ${MAX_AGENT_EXAMPLES} non-empty strings of up to 300 characters`);
    } else agent.examples = raw.examples as string[];
  }
  return agent;
}

const TOP_LEVEL_KEYS = new Set([
  "specVersion",
  "namespace",
  "name",
  "version",
  "description",
  "license",
  "homepage",
  "runtime",
  "permissions",
  "tools",
  "agent",
  "dependencies",
]);

export const MAX_DEPENDENCIES = 50;

/**
 * `dependencies` (reserved, Phase 5): `{ "@ns/name": "<range>" }`. The format is validated so the
 * field is forward compatible, but dependency resolution is not implemented yet: the registry
 * rejects packages that declare dependencies.
 */
function validateDependencies(raw: unknown, selfId: string, errors: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push("dependencies: must be an object mapping package ids to version ranges");
    return undefined;
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_DEPENDENCIES) errors.push(`dependencies: at most ${MAX_DEPENDENCIES} entries`);
  const out: Record<string, string> = {};
  for (const [id, range] of entries) {
    const match = /^@([^/]+)\/([^/]+)$/.exec(id);
    if (!match || !isValidNameSegment(match[1]!) || !isValidNameSegment(match[2]!)) {
      errors.push(`dependencies: invalid package name "${id}"`);
      continue;
    }
    if (id === selfId) {
      errors.push(`dependencies: a package cannot depend on itself (${id})`);
      continue;
    }
    if (typeof range !== "string" || !isValidRange(range) || range === "latest") {
      errors.push(`dependencies.${id}: invalid version range (use 1.2.3, ^1.2.3, ~1.2.3 or *)`);
      continue;
    }
    out[id] = range;
  }
  return out;
}
const TOOL_KEYS = new Set(["name", "description", "entry", "input", "output", "timeoutMs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtensionKey(key: string): boolean {
  return key.startsWith("x-");
}

function requireString(obj: Record<string, unknown>, key: string, path: string, errors: string[], max = 500): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}${key}: is required and must be a non-empty string`);
    return "";
  }
  if (value.length > max) errors.push(`${path}${key}: must be at most ${max} characters`);
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 500) {
    errors.push(`${key}: must be a string of at most 500 characters`);
    return undefined;
  }
  return value;
}

export function isValidToolEntry(entry: string): boolean {
  return (
    isSafeRelativePath(entry) && entry !== "." && TOOL_ENTRY_EXTENSIONS.some((ext) => entry.endsWith(ext))
  );
}

function validateTool(raw: unknown, index: number, errors: string[]): ToolDefinition | null {
  const path = `tools[${index}].`;
  if (!isRecord(raw)) {
    errors.push(`tools[${index}]: must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!TOOL_KEYS.has(key) && !isExtensionKey(key)) errors.push(`${path}${key}: unknown field`);
  }
  const name = requireString(raw, "name", path, errors, 64);
  if (name && !isValidToolName(name)) {
    errors.push(`${path}name: must start with a letter and contain only lowercase letters, digits and dashes`);
  }
  const description = requireString(raw, "description", path, errors);
  const entry = requireString(raw, "entry", path, errors, 256);
  if (entry && !isValidToolEntry(entry)) {
    errors.push(
      `${path}entry: must be a package-relative path without '..' ending in ${TOOL_ENTRY_EXTENSIONS.join(", ")}`,
    );
  }

  let input: JsonSchema = { type: "object" };
  if (raw.input === undefined) {
    errors.push(`${path}input: is required (use {"type":"object"} for tools without input)`);
  } else {
    const schemaErrors = checkSchemaDefinition(raw.input, `${path}input`);
    errors.push(...schemaErrors);
    if (schemaErrors.length === 0) {
      input = raw.input as JsonSchema;
      if (input.type !== "object") errors.push(`${path}input.type: tool input must be "object"`);
    }
  }

  let output: JsonSchema | undefined;
  if (raw.output !== undefined) {
    const schemaErrors = checkSchemaDefinition(raw.output, `${path}output`);
    errors.push(...schemaErrors);
    if (schemaErrors.length === 0) output = raw.output as JsonSchema;
  }

  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    const t = raw.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_TOOL_TIMEOUT_MS) {
      errors.push(`${path}timeoutMs: must be an integer between 1 and ${MAX_TOOL_TIMEOUT_MS}`);
    } else {
      timeoutMs = t;
    }
  }

  const tool: ToolDefinition = { name, description, entry, input };
  if (output) tool.output = output;
  if (timeoutMs !== undefined) tool.timeoutMs = timeoutMs;
  return tool;
}

/** Validates an untrusted manifest object and returns a normalized manifest. */
export function validateManifest(raw: unknown): ValidationResult<Manifest> {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["manifest: must be a JSON object"] };

  if (raw.specVersion === undefined) {
    return { ok: false, errors: ["specVersion: is required"] };
  }
  if (!SUPPORTED_SPEC_VERSIONS.includes(raw.specVersion as number)) {
    return {
      ok: false,
      errors: [
        `specVersion: unsupported version ${JSON.stringify(raw.specVersion)} (supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")})`,
      ],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key) && !isExtensionKey(key)) errors.push(`${key}: unknown field`);
  }

  const namespace = requireString(raw, "namespace", "", errors, 64);
  if (namespace && !isValidNameSegment(namespace)) {
    errors.push("namespace: may only contain lowercase letters, digits and dashes");
  }
  const name = requireString(raw, "name", "", errors, 64);
  if (name && !isValidNameSegment(name)) errors.push("name: may only contain lowercase letters, digits and dashes");
  const version = requireString(raw, "version", "", errors, 64);
  if (version && !isValidVersion(version)) errors.push(`version: "${version}" is not a valid semantic version`);
  const description = requireString(raw, "description", "", errors);
  const license = optionalString(raw, "license", errors);
  const homepage = optionalString(raw, "homepage", errors);

  let runtime: RuntimeInfo = { type: "node" };
  if (raw.runtime !== undefined) {
    if (!isRecord(raw.runtime) || raw.runtime.type !== "node") {
      errors.push('runtime: only {"type":"node"} is supported in spec version 1');
    } else {
      runtime = { type: "node" };
      for (const key of Object.keys(raw.runtime)) {
        if (key !== "type" && key !== "minNodeVersion" && !isExtensionKey(key)) errors.push(`runtime.${key}: unknown field`);
      }
      const min = raw.runtime.minNodeVersion;
      if (min !== undefined) {
        if (typeof min !== "string" || !isValidVersion(min)) errors.push('runtime.minNodeVersion: must be a semantic version like "22.18.0"');
        else runtime.minNodeVersion = min;
      }
    }
  }

  const permissions = normalizePermissions(raw.permissions, errors);

  const tools: ToolDefinition[] = [];
  // An agent package may have no tools of its own; every other package needs at least one.
  const toolless = raw.agent !== undefined && (raw.tools === undefined || (Array.isArray(raw.tools) && raw.tools.length === 0));
  if (toolless) {
    // nothing to validate
  } else if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    errors.push("tools: must be a non-empty array");
  } else {
    raw.tools.forEach((t, i) => {
      const tool = validateTool(t, i, errors);
      if (!tool) return;
      if (tools.some((existing) => existing.name === tool.name)) {
        errors.push(`tools[${i}].name: duplicate tool name "${tool.name}"`);
      }
      tools.push(tool);
    });
  }

  const selfId = namespace && name ? formatPackageId(namespace, name) : "";
  const agent = validateAgent(raw.agent, selfId, errors);
  const dependencies = validateDependencies(raw.dependencies, selfId, errors);

  if (errors.length > 0) return { ok: false, errors };

  const manifest: Manifest = { specVersion: 1, namespace, name, version, description, runtime, permissions, tools };
  if (license !== undefined) manifest.license = license;
  if (homepage !== undefined) manifest.homepage = homepage;
  if (agent !== undefined) manifest.agent = agent;
  if (dependencies !== undefined) manifest.dependencies = dependencies;
  return { ok: true, value: manifest };
}

/** Parses and validates manifest JSON text. */
export function parseManifest(text: string): ValidationResult<Manifest> {
  let raw: unknown;
  try {
    // Editors on Windows often save UTF-8 with a byte order mark; accept it everywhere.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${(error as Error).message}`] };
  }
  return validateManifest(raw);
}

export function manifestId(manifest: Pick<Manifest, "namespace" | "name">): string {
  return formatPackageId(manifest.namespace, manifest.name);
}

export function findTool(manifest: Manifest, name: string): ToolDefinition | undefined {
  return manifest.tools.find((t) => t.name === name);
}
