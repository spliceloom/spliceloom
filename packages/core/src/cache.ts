/**
 * Local artifact cache: `<SPLICE_HOME>/cache/artifacts/sha256/<hex>`.
 *
 * Content-addressed by SHA-256. Only artifacts that passed full verification are written, entries
 * are re-hashed on every read (corrupted entries are deleted) and callers still run the complete
 * verification pipeline on cached bytes — the cache saves a download, never a check. It holds
 * artifact bytes only: no metadata, tokens or credentials.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INTEGRITY_PATTERN, computeIntegrity } from "@spliceloom/spec";
import { spliceHome } from "./user-config.js";

export class ArtifactCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The default cache of a Splice home (SPLICE_HOME, default ~/.splice). */
  static forHome(env: NodeJS.ProcessEnv = process.env): ArtifactCache {
    return new ArtifactCache(join(spliceHome(env), "cache", "artifacts"));
  }

  private path(integrity: string): string | null {
    if (!INTEGRITY_PATTERN.test(integrity)) return null;
    return join(this.dir, "sha256", integrity.slice("sha256-".length));
  }

  /** Cached bytes whose SHA-256 still matches `integrity`, or null. Corrupted entries are removed. */
  async get(integrity: string): Promise<Uint8Array | null> {
    const path = this.path(integrity);
    if (!path) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
    if ((await computeIntegrity(bytes)) !== integrity) {
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
    return bytes;
  }

  /** Stores verified bytes. Best effort: a cache that cannot be written never fails an install. */
  async put(integrity: string, bytes: Uint8Array): Promise<boolean> {
    const path = this.path(integrity);
    if (!path || (await computeIntegrity(bytes)) !== integrity) return false;
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(join(this.dir, "sha256"), { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, path);
      return true;
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }
}
