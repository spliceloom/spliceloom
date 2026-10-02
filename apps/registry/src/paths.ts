import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/registry (dist/.. or src/..). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root. */
export const REPO_ROOT = resolve(APP_ROOT, "../..");
/** D1 migrations, shared by wrangler, the test harness and the local SQLite registry. */
export const MIGRATIONS_DIR = resolve(APP_ROOT, "migrations");
/** Wrangler configuration of the Worker. */
export const WRANGLER_CONFIG = resolve(APP_ROOT, "wrangler.toml");

/** Local registry data directory: SPLICE_DATA_DIR or <repo>/.data. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SPLICE_DATA_DIR ?? resolve(REPO_ROOT, ".data"));
}
