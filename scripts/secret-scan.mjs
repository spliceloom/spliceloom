#!/usr/bin/env node
/**
 * Secret scan: fails if any credential appears in the repository, the build output or the staged
 * npm package. Two checks:
 *  1. exact values of the credentials configured in .env.local / .env (read in memory only, never
 *     printed), including keys embedded in URL paths and query strings;
 *  2. well-known credential formats (OpenRouter, GitHub, Google, Tavily, Firecrawl, Goldsky, JWTs…).
 * Findings are reported as file:line and the rule/variable name only — never the value.
 *
 *   node scripts/secret-scan.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", ".data", "backups"]);
const SKIP_FILES = /^\.env(\..*)?$|^\.dev\.vars$/;
const MAX_BYTES = 5 * 1024 * 1024;

/** Values from the env files (not printed). Only credential-like variables, min. 12 characters. */
function configuredSecrets() {
  const out = [];
  for (const name of [".env.local", ".env"]) {
    const file = join(repo, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      const value = rawValue.trim().replace(/^["']|["']$/g, "");
      if (!/KEY|TOKEN|SECRET|PASSWORD|_URL$/.test(key) || value.length < 12) continue;
      if (/^https?:\/\//.test(value)) {
        try {
          const url = new URL(value);
          for (const seg of url.pathname.split("/")) if (seg.length >= 16) out.push({ key, value: seg });
          for (const v of url.searchParams.values()) if (v.length >= 12) out.push({ key, value: v });
        } catch {
          /* not a URL */
        }
        continue;
      }
      out.push({ key, value });
    }
  }
  return out;
}

const PATTERNS = [
  ["openrouter-key", /sk-or-v1-[0-9a-f]{40,}/],
  ["github-pat", /github_pat_[A-Za-z0-9]{20,}_[A-Za-z0-9]{40,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["tavily-key", /\btvly-(?:dev-)?[A-Za-z0-9-]{24,}\b/],
  ["firecrawl-key", /\bfc-[0-9a-f]{32}\b/],
  ["goldsky-edge-key", /\bgs_edge_[a-z0-9]{20,}\b/],
  ["coingecko-key", /\bCG-[A-Za-z0-9]{20,}\b/],
  ["anthropic-openai-key", /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{30,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
/** Obvious unit-test placeholders (never real credentials). */
// Test files contain fake fixtures for the redaction tests (e.g. the jwt.io sample token); format
// patterns are not applied to them, but configured values are checked everywhere, tests included.
const TEST_FILE = /(\.test\.(ts|js|mjs)|(^|\/)test_[^/]+\.py)$/;
const ALLOW = /unitTest|mcpUnitTest|0{20,}|x{20,}|example|placeholder|REDACTED|<[A-Za-z_]+>/i;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(join(dir, entry.name));
    } else if (!SKIP_FILES.test(entry.name)) yield join(dir, entry.name);
  }
}

const secrets = configuredSecrets();
const findings = [];
let scanned = 0;
for (const file of files(repo)) {
  const size = statSync(file).size;
  if (size === 0 || size > MAX_BYTES) continue;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  scanned++;
  const lines = buf.toString("utf8").split(/\r?\n/);
  const rel = relative(repo, file).split(sep).join("/");
  lines.forEach((line, i) => {
    for (const { key, value } of secrets) if (line.includes(value)) findings.push(`${rel}:${i + 1}  configured value of ${key}`);
    if (TEST_FILE.test(rel)) return;
    for (const [rule, re] of PATTERNS) {
      const m = re.exec(line);
      if (m && !ALLOW.test(m[0])) findings.push(`${rel}:${i + 1}  ${rule}`);
    }
  });
}

console.log(`secret scan: ${scanned} text files, ${secrets.length} configured credential values, ${PATTERNS.length} patterns (env files themselves are excluded)`);
if (findings.length) {
  for (const f of [...new Set(findings)]) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("  ✓ no credentials found (repository, build output, staged npm package)");
