#!/usr/bin/env node
/**
 * Publishes skill directories into the LOCAL registry directly through the service, as the
 * built-in `splice` user (which owns the reserved @splice namespace). Development only.
 *
 *   node apps/registry/dist/seed.js                 # every directory under <repo>/skills
 *   node apps/registry/dist/seed.js path/to/skill   # specific directories
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreError, packDirectory } from "@spliceloom/core";
import { manifestId } from "@spliceloom/spec";
import { openLocalRegistry } from "./node.js";
import { REPO_ROOT, dataDir } from "./paths.js";
import { RegistryError, type AuthUser, type RegistryService } from "./service.js";

export const SEED_USER = "splice";

async function ensureSeedUser(service: RegistryService): Promise<AuthUser> {
  const user = (await service.getUser(SEED_USER)) ?? (await service.createUser(SEED_USER));
  await service.setNamespaceOwner("splice", SEED_USER);
  return user;
}

export async function seedDirectories(service: RegistryService, dirs: string[]): Promise<string[]> {
  const user = await ensureSeedUser(service);
  const lines: string[] = [];
  for (const dir of dirs) {
    const packed = await packDirectory(dir);
    const id = `${manifestId(packed.manifest)}@${packed.manifest.version}`;
    try {
      await service.publish(packed.bytes, user);
      lines.push(`published ${id} (${packed.integrity.slice(0, 19)}...)`);
    } catch (error) {
      if (!(error instanceof RegistryError) || error.code !== "VERSION_EXISTS") throw error;
      const existing = await service.getVersion(manifestId(packed.manifest), packed.manifest.version);
      if (existing.integrity !== packed.integrity) {
        throw new Error(`${id} is already published with different contents. Bump the version in manifest.json.`);
      }
      lines.push(`unchanged ${id}`);
    }
  }
  return lines;
}

function defaultSkillDirs(): string[] {
  const root = join(REPO_ROOT, "skills");
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => statSync(p).isDirectory());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args.map((a) => resolve(a)) : defaultSkillDirs();
  const dir = dataDir();
  const service = openLocalRegistry(dir);
  try {
    for (const line of await seedDirectories(service, dirs)) console.log(line);
    console.log(`registry data: ${dir}`);
  } finally {
    await service.close();
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith(join("dist", "seed.js"));
if (invokedDirectly) {
  main().catch((error) => {
    const details = error instanceof CoreError || error instanceof RegistryError ? error.details : [];
    console.error(`seed failed: ${(error as Error).message}`);
    for (const d of details) console.error(`  - ${d}`);
    process.exit(1);
  });
}
