// Runs the repo-pinned wrangler against apps/registry/wrangler.toml, with telemetry disabled.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "registry");
const require = createRequire(join(appDir, "package.json"));
const bin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
process.exit(result.status ?? 1);
