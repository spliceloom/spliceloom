// Backs up the registry: a full D1 SQL export plus every artifact referenced by D1 (downloaded from
// its recorded URL — GitHub Releases — or from legacy KV), each verified against the SHA-256 in its
// content-addressed key.
//
//   node scripts/backup.mjs            # production (--remote), needs `wrangler login`
//   node scripts/backup.mjs --local    # the local wrangler dev state
//   node scripts/backup.mjs --out <dir>
//
// Output: backups/<timestamp>/{d1.sql, artifacts/<key>, backup.json}. backups/ is git-ignored.
// Read-only against the registry. Restore steps: docs/deployment.md#backups-and-restore.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "registry");
const require = createRequire(join(appDir, "package.json"));
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

const args = process.argv.slice(2);
const target = args.includes("--local") ? "--local" : "--remote";
const outIndex = args.indexOf("--out");
const outRoot = resolve(outIndex !== -1 ? args[outIndex + 1] : join(root, "backups"));

function wrangler(argv, { binary = false } = {}) {
  const result = spawnSync(process.execPath, [wranglerBin, ...argv], {
    cwd: appDir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
    encoding: binary ? "buffer" : "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${argv.slice(0, 3).join(" ")} failed:\n${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout;
}

const toml = readFileSync(join(appDir, "wrangler.toml"), "utf8");
const database = /database_name\s*=\s*"([^"]+)"/.exec(toml)?.[1];
const kvId = /\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*"([^"]+)"/.exec(toml)?.[1];
if (!database) throw new Error("database_name not found in wrangler.toml");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(outRoot, `${stamp}${target === "--local" ? "-local" : ""}`);
mkdirSync(dir, { recursive: true });

console.log(`backing up ${target === "--local" ? "LOCAL" : "PRODUCTION"} registry to ${dir}`);
wrangler(["d1", "export", database, target, "--output", join(dir, "d1.sql")]);
console.log("✓ D1 exported to d1.sql");

// Every version recorded in D1, wherever its artifact lives.
const query = "SELECT package_id, version, artifact_key, artifact_backend, artifact_url FROM versions ORDER BY package_id, version";
const rows = JSON.parse(wrangler(["d1", "execute", database, target, "--json", "--command", query]))[0].results;
const keyPattern = /^packages\/[a-z0-9-]+\/[a-z0-9-]+\/[0-9A-Za-z.-]+\/([0-9a-f]{64})(\.tar\.gz|\.bundle\.json)$/;

async function fetchArtifact(row) {
  // GitHub Releases (and any backend exposing a URL): the public download URL.
  if (row.artifact_url) {
    const res = await fetch(row.artifact_url, { headers: { "user-agent": "splice-backup" } });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    console.warn(`! ${row.artifact_url} returned HTTP ${res.status}; trying KV`);
  }
  // Legacy artifacts stored in Workers KV.
  if (kvId) return wrangler(["kv", "key", "get", row.artifact_key, "--namespace-id", kvId, target], { binary: true });
  throw new Error(`no source for ${row.package_id}@${row.version}`);
}

let artifacts = 0;
for (const row of rows) {
  const match = keyPattern.exec(row.artifact_key);
  if (!match) throw new Error(`unexpected artifact key ${row.artifact_key}`);
  const bytes = await fetchArtifact(row);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== match[1]) throw new Error(`artifact ${row.artifact_key} failed verification (sha256 ${actual})`);
  const file = join(dir, "artifacts", ...row.artifact_key.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  artifacts++;
}
console.log(`✓ ${artifacts} artifact(s) downloaded and verified against their SHA-256`);

writeFileSync(
  join(dir, "backup.json"),
  JSON.stringify({ createdAt: new Date().toISOString(), target: target.slice(2), database, kvNamespace: kvId ?? null, artifacts }, null, 2) + "\n",
);
console.log("✓ done");
