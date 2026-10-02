#!/usr/bin/env node
/**
 * Builds the publishable npm package for the Splice CLI in dist-npm/cli/ and (unless --no-pack)
 * packs it into dist-npm/spliceloom-cli-<version>.tgz.
 *
 * The package is self-contained: the workspace packages it needs (@spliceloom/spec, runtime,
 * core, data, sdk, mcp) are copied into its node_modules and declared as bundleDependencies, so
 * `npm install -g @spliceloom/cli` needs nothing else from the npm registry. Only compiled
 * runtime files are included â€” no tests, source maps, sources, configuration or local state.
 *
 *   npm run build && node scripts/pack-cli.mjs           # stage, check contents, pack
 *   node scripts/pack-cli.mjs --dry-run [--list]         # stage + `npm pack --dry-run` + contents check
 *
 * It never publishes. Publishing is a separate, manual step (docs/releasing.md).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "dist-npm");
const stage = join(out, "cli");
export const INTERNAL = ["spec", "runtime", "core", "data", "sdk", "mcp"];

/** Files that belong in the published package (compiled JavaScript and type declarations). */
export function isShippedFile(path) {
  const name = path.split(/[\\/]/).pop();
  if (/\.test\.(js|mjs|d\.ts|d\.mts)$/.test(name)) return false;
  if (/^(fake-|testing)/.test(name)) return false;
  if (name.endsWith(".map") || name.endsWith(".tsbuildinfo")) return false;
  return /\.(js|mjs|d\.ts|d\.mts)$/.test(name);
}

function copyDist(from, to) {
  if (!existsSync(from)) throw new Error(`${relative(repo, from)} is missing â€” run \`npm run build\` first`);
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

export function stageCli() {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const cli = readJson(join(repo, "packages", "cli", "package.json"));
  copyDist(join(repo, "packages", "cli", "dist"), join(stage, "dist"));
  for (const name of INTERNAL) {
    const dir = join(stage, "node_modules", "@spliceloom", name);
    mkdirSync(dir, { recursive: true });
    copyDist(join(repo, "packages", name, "dist"), join(dir, "dist"));
    writeJson(join(dir, "package.json"), runtimeManifest(readJson(join(repo, "packages", name, "package.json"))));
  }

  const manifest = {
    ...runtimeManifest(cli),
    description: "Splice CLI â€” install, verify and run composable capabilities (skills) for autonomous agents.",
    keywords: ["splice", "agents", "mcp", "skills", "cli", "sandbox", "package-manager"],
    homepage: "https://github.com/spliceloom",
    bin: cli.bin,
    files: ["dist", "README.md", "LICENSE"],
    bundleDependencies: INTERNAL.map((n) => `@spliceloom/${n}`),
    publishConfig: { access: "public" },
  };
  writeJson(join(stage, "package.json"), manifest);
  copyFileSync(join(repo, "packages", "cli", "README.md"), join(stage, "README.md"));
  copyFileSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
  return { stage, manifest };
}

/** Every file in the staged package, relative, with "/" separators. */
export function listStaged(dir = stage) {
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
 * compiled output of the CLI and its bundled workspace packages (tests, maps, sources, configs,
 * secrets, local state) is refused.
 */
export function checkPackFiles(paths) {
  const problems = [];
  const allowedRoots = new Set(["package.json", "README.md", "LICENSE"]);
  for (const path of paths) {
    if (allowedRoots.has(path)) continue;
    const bundled = /^node_modules\/@spliceloom\/(spec|runtime|core|data|sdk|mcp)\/(package\.json|dist\/.+)$/.exec(path);
    const own = /^dist\/.+$/.test(path);
    if (!own && !bundled) problems.push(`unexpected path: ${path}`);
    else if (!path.endsWith("package.json") && !isShippedFile(path)) problems.push(`not a runtime file: ${path}`);
    if (/(^|\/)\.(env|dev\.vars|npmrc|git)|credential|secret|\.pem$|\.key$|wrangler|\.data\/|backups?\//i.test(path)) problems.push(`sensitive-looking path: ${path}`);
  }
  if (!paths.includes("dist/bin.js")) problems.push("missing dist/bin.js (the `splice` executable)");
  if (!paths.includes("node_modules/@spliceloom/runtime/dist/host.mjs")) problems.push("missing the sandbox host (runtime/dist/host.mjs)");
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
  const { manifest } = stageCli();
  console.log(`staged ${manifest.name}@${manifest.version} in ${relative(repo, stage)} (${listStaged().length} files)`);
  // What npm would publish, checked before anything is packed.
  const dry = JSON.parse(npm(["pack", "--dry-run", "--json"], stage))[0];
  const paths = dry.files.map((f) => f.path).sort();
  const problems = checkPackFiles(paths);
  const groups = {};
  for (const path of paths) {
    const key = path.startsWith("node_modules/") ? path.split("/").slice(0, 3).join("/") : path.split("/")[0];
    groups[key] = (groups[key] ?? 0) + 1;
  }
  console.log(`npm pack --dry-run: ${dry.name}@${dry.version}, ${dry.entryCount} files, ${dry.size} bytes packed, ${dry.unpackedSize} unpacked`);
  for (const [key, count] of Object.entries(groups)) console.log(`  ${key.padEnd(40)} ${count}`);
  if (process.argv.includes("--list")) for (const path of paths) console.log(`    ${path}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  âœ— ${p}`);
    process.exit(1);
  }
  console.log("  âœ“ contents check passed (compiled runtime files only)");
  if (!process.argv.includes("--no-pack") && !process.argv.includes("--dry-run")) {
    const report = JSON.parse(npm(["pack", "--json", "--pack-destination", out], stage))[0];
    console.log(`packed ${relative(repo, join(out, report.filename))}: ${report.entryCount} files, ${report.size} bytes (unpacked ${report.unpackedSize}), sha512 ${report.integrity}`);
    for (const bundled of report.bundled ?? []) console.log(`  bundled ${bundled}`);
  }
}
