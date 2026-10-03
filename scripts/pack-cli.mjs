#!/usr/bin/env node
/**
 * Builds the publishable npm packages in dist-npm/<target>/ and (unless --no-pack / --dry-run)
 * packs them into dist-npm/spliceloom-<target>-<version>.tgz:
 *
 *   cli  @spliceloom/cli — the `splice` command
 *   sdk  @spliceloom/sdk — the TypeScript SDK
 *   adapters  @spliceloom/adapters — Splice tools for agent frameworks
 *
 * Each package is self-contained: the workspace packages it needs are copied into its node_modules
 * and declared as bundleDependencies, so installing it needs nothing else from the npm registry.
 * Only compiled runtime files are included — no tests, source maps, sources, configuration or local
 * state.
 *
 *   npm run build && node scripts/pack-cli.mjs [--target cli|sdk|adapters]   # stage, check contents, pack
 *   node scripts/pack-cli.mjs --target sdk --dry-run [--list]         # stage + `npm pack --dry-run` + check
 *
 * It never publishes. Publishing is a separate, manual step (docs/releasing.md).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "dist-npm");

export const TARGETS = {
  cli: {
    internal: ["spec", "runtime", "core", "data", "sdk", "mcp"],
    description: "Splice CLI — live Robinhood Chain and market data, an AI agent with sources, and verified, sandboxed skills for autonomous agents.",
    keywords: ["splice", "agents", "ai-agents", "mcp", "skills", "cli", "sandbox", "robinhood-chain", "onchain", "defi"],
    homepage: "https://docs.spliceloom.com/quickstart",
    bin: true,
    required: ["dist/bin.js", "node_modules/@spliceloom/runtime/dist/host.mjs"],
  },
  sdk: {
    internal: ["spec", "runtime", "core", "data"],
    description: "Splice SDK — search, verify, install and run sandboxed skills, and read live Robinhood Chain and market data with provenance, from TypeScript.",
    keywords: ["splice", "sdk", "agents", "ai-agents", "skills", "sandbox", "robinhood-chain", "onchain", "typescript"],
    homepage: "https://docs.spliceloom.com/sdk",
    bin: false,
    required: ["dist/index.js", "dist/index.d.ts", "node_modules/@spliceloom/runtime/dist/host.mjs"],
  },
  adapters: {
    internal: ["spec", "runtime", "core", "data", "sdk", "mcp"],
    description: "Splice tools for agent frameworks — OpenAI, the OpenAI Agents SDK, LangChain and the Vercel AI SDK: live Robinhood Chain data and verified, sandboxed skills.",
    keywords: ["splice", "agents", "ai-agents", "openai", "langchain", "ai-sdk", "tools", "function-calling", "robinhood-chain", "onchain"],
    homepage: "https://docs.spliceloom.com/adapters",
    bin: false,
    required: ["dist/index.js", "dist/index.d.ts", "node_modules/@spliceloom/runtime/dist/host.mjs"],
  },
};
/** Workspace packages bundled into the CLI (kept for existing imports). */
export const INTERNAL = TARGETS.cli.internal;

/** Files that belong in the published package (compiled JavaScript and type declarations). */
export function isShippedFile(path) {
  const name = path.split(/[\\/]/).pop();
  if (/\.test\.(js|mjs|d\.ts|d\.mts)$/.test(name)) return false;
  if (/^(fake-|testing)/.test(name)) return false;
  if (name.endsWith(".map") || name.endsWith(".tsbuildinfo")) return false;
  return /\.(js|mjs|d\.ts|d\.mts)$/.test(name);
}

function copyDist(from, to) {
  if (!existsSync(from)) throw new Error(`${relative(repo, from)} is missing — run \`npm run build\` first`);
  cpSync(from, to, {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() || isShippedFile(src),
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Keeps only the fields a runtime consumer needs. */
function runtimeManifest(pkg) {
  const keep = ["name", "version", "description", "license", "type", "main", "types", "exports", "engines", "dependencies"];
  return Object.fromEntries(keep.filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]]));
}

/** Stages one target in dist-npm/<target>/. */
export function stagePackage(target = "cli") {
  const config = TARGETS[target];
  if (!config) throw new Error(`unknown target "${target}" (use: ${Object.keys(TARGETS).join(", ")})`);
  const stage = join(out, target);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const pkg = readJson(join(repo, "packages", target, "package.json"));
  copyDist(join(repo, "packages", target, "dist"), join(stage, "dist"));
  for (const name of config.internal) {
    const dir = join(stage, "node_modules", "@spliceloom", name);
    mkdirSync(dir, { recursive: true });
    copyDist(join(repo, "packages", name, "dist"), join(dir, "dist"));
    writeJson(join(dir, "package.json"), runtimeManifest(readJson(join(repo, "packages", name, "package.json"))));
  }

  const manifest = {
    ...runtimeManifest(pkg),
    description: config.description,
    keywords: config.keywords,
    homepage: config.homepage,
    repository: { type: "git", url: "git+https://github.com/spliceloom/spliceloom.git", directory: `packages/${target}` },
    bugs: { url: "https://github.com/spliceloom/spliceloom/issues" },
    ...(config.bin ? { bin: pkg.bin } : {}),
    files: ["dist", "README.md", "LICENSE"],
    bundleDependencies: config.internal.map((n) => `@spliceloom/${n}`),
    publishConfig: { access: "public" },
  };
  writeJson(join(stage, "package.json"), manifest);
  copyFileSync(join(repo, "packages", target, "README.md"), join(stage, "README.md"));
  copyFileSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
  return { stage, manifest };
}

/** The CLI package (kept for existing callers). */
export function stageCli() {
  return stagePackage("cli");
}

/** Every file in a staged package, relative, with "/" separators. */
export function listStaged(dir = join(out, "cli")) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.sort();
}

/**
 * Problems with a list of packed paths: anything that is not the manifest, README, LICENSE or
 * compiled output of the package and its bundled workspace packages (tests, maps, sources, configs,
 * secrets, local state) is refused.
 */
export function checkPackFiles(paths, target = "cli") {
  const config = TARGETS[target];
  const problems = [];
  const allowedRoots = new Set(["package.json", "README.md", "LICENSE"]);
  const bundledRe = new RegExp(`^node_modules/@spliceloom/(${config.internal.join("|")})/(package\\.json|dist/.+)$`);
  for (const path of paths) {
    if (allowedRoots.has(path)) continue;
    const bundled = bundledRe.exec(path);
    const own = /^dist\/.+$/.test(path);
    if (!own && !bundled) problems.push(`unexpected path: ${path}`);
    else if (!path.endsWith("package.json") && !isShippedFile(path)) problems.push(`not a runtime file: ${path}`);
    if (/(^|\/)\.(env|dev\.vars|npmrc|git)|credential|secret|\.pem$|\.key$|wrangler|\.data\/|backups?\//i.test(path)) problems.push(`sensitive-looking path: ${path}`);
  }
  for (const required of config.required) {
    if (!paths.includes(required)) problems.push(required === "dist/bin.js" ? "missing dist/bin.js (the `splice` executable)" : required.endsWith("host.mjs") ? "missing the sandbox host (runtime/dist/host.mjs)" : `missing ${required}`);
  }
  return problems;
}

function npm(args, cwd) {
  // npm is a .cmd shim on Windows, which Node only starts through a shell; pass one quoted command
  // string (the arguments are fixed by this script).
  const quote = (a) => (/^[\w@./:=-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
  const r = spawnSync(["npm", ...args].map(quote).join(" "), { cwd, encoding: "utf8", shell: true });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--target");
  const target = at >= 0 ? process.argv[at + 1] : "cli";
  const { stage, manifest } = stagePackage(target);
  console.log(`staged ${manifest.name}@${manifest.version} in ${relative(repo, stage)} (${listStaged(stage).length} files)`);
  // What npm would publish, checked before anything is packed.
  const dry = JSON.parse(npm(["pack", "--dry-run", "--json"], stage))[0];
  const paths = dry.files.map((f) => f.path).sort();
  const problems = checkPackFiles(paths, target);
  const groups = {};
  for (const path of paths) {
    const key = path.startsWith("node_modules/") ? path.split("/").slice(0, 3).join("/") : path.split("/")[0];
    groups[key] = (groups[key] ?? 0) + 1;
  }
  console.log(`npm pack --dry-run: ${dry.name}@${dry.version}, ${dry.entryCount} files, ${dry.size} bytes packed, ${dry.unpackedSize} unpacked`);
  for (const [key, count] of Object.entries(groups)) console.log(`  ${key.padEnd(40)} ${count}`);
  if (process.argv.includes("--list")) for (const path of paths) console.log(`    ${path}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("  ✓ contents check passed (compiled runtime files only)");
  if (!process.argv.includes("--no-pack") && !process.argv.includes("--dry-run")) {
    const report = JSON.parse(npm(["pack", "--json", "--pack-destination", out], stage))[0];
    console.log(`packed ${relative(repo, join(out, report.filename))}: ${report.entryCount} files, ${report.size} bytes (unpacked ${report.unpackedSize}), sha512 ${report.integrity}`);
    for (const bundled of report.bundled ?? []) console.log(`  bundled ${bundled}`);
  }
}
