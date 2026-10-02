/**
 * Registry data for the website, read from the public registry API (the same API the CLI uses):
 *
 *   website build → RegistryClient → GET /packages/:ns/:name, /:version → D1 metadata
 *                 → verifyPackage (download + SHA-256 + size + package + metadata + provenance)
 *
 * Nothing is hard-coded: versions, descriptions, permissions, tools and verification results come
 * from the registry at build time, and the page refreshes versions live in the browser (CORS).
 */
import { RegistryClient, verifyPackage, type FetchLike } from "../../../packages/core/dist/index.js";
import { describePermissions, describeTools, type Permissions } from "../../../packages/spec/dist/index.js";

export const OFFICIAL_SKILLS = ["@splice/json", "@splice/http", "@splice/files", "@splice/github"] as const;
/**
 * Official skills shown when the registry already serves them (broker skills published after the
 * first four). A registry that does not have one yet simply does not list it — nothing is invented.
 */
export const OPTIONAL_SKILLS = ["@splice/robinhood", "@splice/web", "@splice/market", "@splice/onchain"] as const;

export interface ToolView {
  name: string;
  qualifiedName: string;
  mcpName: string;
  description: string;
  inputs: Array<{ name: string; type: string; required: boolean; description: string }>;
}

export interface SkillView {
  id: string;
  namespace: string;
  name: string;
  description: string;
  version: string;
  versions: string[];
  publishedAt: string;
  publisher: string;
  integrity: string;
  size: number;
  artifactUrl: string | null;
  permissions: Permissions;
  permissionSummary: string[];
  tools: ToolView[];
  verification: {
    verified: boolean;
    checkedAt: string;
    checks: Array<{ id: string; status: string; message: string }>;
  };
}

export interface RegistrySnapshot {
  registry: string;
  generatedAt: string;
  skills: SkillView[];
}

function typeLabel(schema: { type?: string; enum?: unknown[]; items?: { type?: string } }): string {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.type === "array") return `${schema.items?.type ?? "any"}[]`;
  return schema.type ?? "any";
}

/** Loads one package's latest version and verifies it exactly like `splice verify`. */
export async function loadSkill(client: RegistryClient, id: string, options: { verify?: boolean; fetch?: (url: string) => Promise<Response> } = {}): Promise<SkillView> {
  const pkg = await client.getPackage(id);
  const version = await client.getVersion(id, pkg.latest);
  const manifest = version.manifest;
  const tools = describeTools(manifest).map((t) => {
    const props = (t.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown[]; items?: { type?: string } }>;
    const required = new Set(t.inputSchema.required ?? []);
    return {
      name: t.name,
      qualifiedName: t.qualifiedName,
      mcpName: t.mcpName,
      description: t.description,
      inputs: Object.entries(props).map(([name, s]) => ({ name, type: typeLabel(s), required: required.has(name), description: s.description ?? "" })),
    };
  });
  let verification: SkillView["verification"] = { verified: false, checkedAt: new Date().toISOString(), checks: [] };
  if (options.verify !== false) {
    const verifyOptions: { fetch?: (url: string) => Promise<Response> } = {};
    if (options.fetch) verifyOptions.fetch = options.fetch;
    const report = await verifyPackage(client, `${id}@${pkg.latest}`, verifyOptions);
    verification = {
      verified: report.verified,
      checkedAt: new Date().toISOString(),
      checks: report.checks.filter((c) => c.id !== "installed").map((c) => ({ id: c.id, status: c.status, message: c.message })),
    };
  }
  return {
    id,
    namespace: pkg.namespace,
    name: id.slice(id.indexOf("/") + 1),
    description: pkg.description,
    version: pkg.latest,
    versions: pkg.versions.map((v) => v.version),
    publishedAt: version.publishedAt,
    publisher: version.provenance?.publisher.user ?? version.publishedBy,
    integrity: version.integrity,
    size: version.size,
    artifactUrl: version.artifact?.url ?? null,
    permissions: manifest.permissions,
    permissionSummary: describePermissions(manifest.permissions),
    tools,
    verification,
  };
}

export async function loadSnapshot(registry: string, options: { ids?: readonly string[]; optional?: readonly string[]; fetch?: FetchLike; verify?: boolean } = {}): Promise<RegistrySnapshot> {
  const client = new RegistryClient(registry, options.fetch);
  const skills: SkillView[] = [];
  const skillOptions: { verify?: boolean; fetch?: (url: string) => Promise<Response> } = {};
  if (options.verify !== undefined) skillOptions.verify = options.verify;
  if (options.fetch) skillOptions.fetch = (url: string) => options.fetch!(url);
  for (const id of options.ids ?? OFFICIAL_SKILLS) skills.push(await loadSkill(client, id, skillOptions));
  for (const id of options.optional ?? (options.ids ? [] : OPTIONAL_SKILLS)) {
    try {
      skills.push(await loadSkill(client, id, skillOptions));
    } catch (error) {
      // Not published on this registry (yet): not shown. Any other failure is a real error.
      if ((error as { code?: string }).code !== "PACKAGE_NOT_FOUND") throw error;
    }
  }
  return { registry: client.baseUrl, generatedAt: new Date().toISOString(), skills };
}
