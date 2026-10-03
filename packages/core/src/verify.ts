/**
 * `splice verify` / `splice.verify()`: factual, deterministic verification of a published version.
 * Never installs or executes anything. Reports checks; it does not compute trust scores.
 */
import { join } from "node:path";
import {
  canonicalJson,
  computeIntegrity,
  isEmptyPermissions,
  maxSatisfying,
  parsePackageRef,
  ungrantedPermissions,
  verifyArtifact,
  type ProvenanceRecord,
  type VerificationCheck,
} from "@spliceloom/spec";
import { CoreError } from "./errors.js";
import { packDirectory } from "./pack.js";
import type { SpliceProject } from "./project.js";
import type { RegistryClient } from "./registry-client.js";

export interface VerificationReport {
  package: string;
  version: string;
  /** True when no check failed. */
  verified: boolean;
  publisher: string;
  publishedAt: string;
  artifact: { integrity: string; size: number; filename: string | null; backend: string | null; url: string | null };
  provenance: ProvenanceRecord | null;
  checks: VerificationCheck[];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifyOptions {
  /** When given and the version is installed there, the installed copy is verified too. */
  project?: SpliceProject;
  /** Fetch used for the direct artifact URL (default global fetch). */
  fetch?: (url: string) => Promise<Response>;
}

export async function verifyPackage(client: RegistryClient, refInput: string, options: VerifyOptions = {}): Promise<VerificationReport> {
  const ref = parsePackageRef(refInput);
  const pkg = await client.getPackage(ref.id);
  const version = maxSatisfying(pkg.versions.map((v) => v.version), ref.range);
  if (!version) {
    throw new CoreError("NO_MATCHING_VERSION", `No version of ${ref.id} matches "${ref.range}".`, {
      details: [`available: ${pkg.versions.map((v) => v.version).join(", ") || "none"}`],
    });
  }
  const info = await client.getVersion(ref.id, version);
  const report: VerificationReport = {
    package: ref.id,
    version,
    verified: false,
    publisher: info.provenance?.publisher.user ?? info.publishedBy,
    publishedAt: info.publishedAt,
    artifact: {
      integrity: info.integrity,
      size: info.size,
      filename: info.artifact?.filename ?? null,
      backend: info.artifact?.backend ?? null,
      url: info.artifact?.url ?? null,
    },
    provenance: info.provenance ?? null,
    checks: [],
  };

  // 1. Artifact (downloaded through the registry): sha256, size, package, metadata, signature.
  const { bytes } = await client.downloadArtifact(ref.id, version);
  const result = await verifyArtifact({
    bytes,
    expected: { id: ref.id, version, integrity: info.integrity, size: info.size, manifest: info.manifest, ...(info.signatures ? { signatures: info.signatures } : {}) },
  });
  report.checks.push(...result.checks);

  // 2. Provenance consistency.
  const p = info.provenance;
  if (!p) {
    report.checks.push({ id: "provenance", status: "skipped", message: "registry did not report provenance" });
  } else if (!p.recorded) {
    report.checks.push({ id: "provenance", status: "skipped", message: "published before provenance was recorded (derived from metadata)" });
  } else {
    const problems: string[] = [];
    if (p.package !== ref.id || p.version !== version) problems.push("package/version differ");
    if (p.artifact.integrity !== info.integrity) problems.push("artifact integrity differs from version metadata");
    if (p.artifact.size !== info.size) problems.push("artifact size differs from version metadata");
    if (p.manifestSha256 && p.manifestSha256 !== (await sha256Hex(canonicalJson(info.manifest)))) problems.push("manifest hash differs from version metadata");
    report.checks.push(
      problems.length === 0
        ? { id: "provenance", status: "passed", message: `recorded at publish by ${p.publisher.user} (${p.publisher.via}) on ${p.publishedAt}` }
        : { id: "provenance", status: "failed", message: `provenance does not match metadata: ${problems.join("; ")}` },
    );
  }

  // 3. The direct artifact URL (e.g. GitHub Releases) must serve the same bytes.
  const url = info.artifact?.url;
  if (!url || !url.startsWith("https://")) {
    report.checks.push({ id: "source", status: "skipped", message: "no direct artifact URL" });
  } else {
    try {
      const res = await (options.fetch ?? ((u: string) => fetch(u, { headers: { "user-agent": "splice-verify" } })))(url);
      if (!res.ok) {
        report.checks.push({ id: "source", status: "skipped", message: `direct URL returned HTTP ${res.status}` });
      } else {
        const direct = await computeIntegrity(new Uint8Array(await res.arrayBuffer()));
        report.checks.push(
          direct === info.integrity
            ? { id: "source", status: "passed", message: `direct artifact URL serves the same bytes (${direct})` }
            : { id: "source", status: "failed", message: `direct artifact URL serves different bytes (${direct})` },
        );
      }
    } catch (error) {
      report.checks.push({ id: "source", status: "skipped", message: `direct URL unreachable: ${(error as Error).message}` });
    }
  }

  // 4. Installed copy, if any.
  const project = options.project;
  const entry = project ? (await project.readLock()).packages[ref.id] : undefined;
  if (!project || !entry) {
    report.checks.push({ id: "installed", status: "skipped", message: "not installed in this project" });
  } else if (entry.version !== version) {
    report.checks.push({ id: "installed", status: "skipped", message: `installed version is ${entry.version}` });
  } else if (entry.integrity !== info.integrity) {
    report.checks.push({ id: "installed", status: "failed", message: `lockfile integrity ${entry.integrity} differs from the registry` });
  } else if (!result.files) {
    report.checks.push({ id: "installed", status: "skipped", message: "artifact did not verify" });
  } else {
    try {
      const local = await packDirectory(project.packageDir(ref.id));
      const expected = new Map(result.files.map((f) => [f.path, f.content]));
      const same =
        local.files.length === expected.size &&
        local.files.every((f) => {
          const other = expected.get(f.path);
          return other !== undefined && other.length === f.content.length && other.every((b, i) => b === f.content[i]);
        });
      const ungranted = entry.permissions ? ungrantedPermissions(local.manifest.permissions, entry.permissions) : null;
      if (!same) report.checks.push({ id: "installed", status: "failed", message: `installed files in ${join(".splice", "packages", ref.id)} differ from the artifact` });
      else if (ungranted && !isEmptyPermissions(ungranted)) report.checks.push({ id: "installed", status: "failed", message: "installed manifest requests permissions that were not granted" });
      else report.checks.push({ id: "installed", status: "passed", message: "installed files are identical to the verified artifact" });
    } catch (error) {
      report.checks.push({ id: "installed", status: "failed", message: `installed copy is invalid: ${(error as Error).message}` });
    }
  }

  report.verified = !report.checks.some((c) => c.status === "failed");
  return report;
}
