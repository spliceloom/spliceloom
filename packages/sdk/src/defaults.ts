/** Default implementations of the SDK interfaces, built on @spliceloom/core and @spliceloom/runtime. */
import {
  CoreError,
  addPackage,
  assertInstalledIntact,
  installProject,
  listPackages,
  outdatedPackages,
  removePackage,
  updatePackages,
  type AddOptions,
  type ArtifactCache,
  type RegistryClient,
  type SpliceProject,
  type UpdateOptions,
} from "@spliceloom/core";
import { RuntimeError, loadPackage, type LoadedPackage } from "@spliceloom/runtime";
import {
  describePermissions,
  isEmptyPermissions,
  isValidNameSegment,
  maxSatisfying,
  parsePackageId,
  parsePackageRef,
  ungrantedPermissions,
} from "@spliceloom/spec";
import type { PackageManager, PackageResolver, SkillLoader } from "./interfaces.js";

export class RegistryPackageResolver implements PackageResolver {
  constructor(private readonly client: () => Promise<RegistryClient>) {}

  async resolve(refInput: string): Promise<{ id: string; version: string }> {
    const ref = parsePackageRef(refInput);
    const pkg = await (await this.client()).getPackage(ref.id);
    const version = maxSatisfying(pkg.versions.map((v) => v.version), ref.range);
    if (!version) {
      throw new CoreError("NO_MATCHING_VERSION", `No version of ${ref.id} matches "${ref.range}".`, {
        details: [`available: ${pkg.versions.map((v) => v.version).join(", ") || "none"}`],
      });
    }
    return { id: ref.id, version };
  }
}

/** Package lifecycle on a project directory; the same core functions the CLI uses. */
export class ProjectPackageManager implements PackageManager {
  constructor(
    private readonly project: () => Promise<SpliceProject>,
    private readonly client: () => Promise<RegistryClient>,
    /** Local artifact cache used unless the call passes its own `cache`. */
    private readonly cache: ArtifactCache | null = null,
  ) {}

  private withCache<T extends AddOptions>(options: T | undefined): T {
    return { cache: this.cache, ...options } as T;
  }

  async add(ref: string, options?: AddOptions) {
    return addPackage(await this.project(), await this.client(), ref, this.withCache(options));
  }

  async install(options?: AddOptions) {
    return installProject(await this.project(), await this.client(), this.withCache(options));
  }

  async outdated(ids: string[] = []) {
    return outdatedPackages(await this.project(), await this.client(), ids);
  }

  async update(ids: string[] = [], options?: UpdateOptions) {
    return updatePackages(await this.project(), await this.client(), ids, this.withCache(options));
  }

  async remove(id: string) {
    return removePackage(await this.project(), id);
  }

  async list() {
    return listPackages(await this.project());
  }
}

export class ProjectSkillLoader implements SkillLoader {
  constructor(private readonly project: () => Promise<SpliceProject>) {}

  private async idFor(ref: string): Promise<string> {
    const project = await this.project();
    const installed = Object.keys((await project.readLock()).packages);
    if (ref.startsWith("@")) {
      const { id } = parsePackageId(ref);
      if (!installed.includes(id)) throw new CoreError("NOT_INSTALLED", `No installed package named "${id}".`, { hint: `Run \`splice add ${id}\`.` });
      return id;
    }
    if (!isValidNameSegment(ref)) throw new CoreError("NOT_INSTALLED", `Invalid package reference "${ref}".`);
    const matches = installed.filter((id) => parsePackageId(id).name === ref);
    if (matches.length === 0) {
      throw new CoreError("NOT_INSTALLED", `No installed package named "${ref}".`, {
        hint: `Run \`splice search ${ref}\` and \`splice add <package>\`.`,
      });
    }
    if (matches.length > 1) {
      throw new CoreError("AMBIGUOUS_TOOL", `"${ref}" matches several installed packages.`, {
        details: matches,
        hint: `Use the full name, e.g. ${matches[0]}.`,
      });
    }
    return matches[0]!;
  }

  /** Refuses packages whose installed manifest requests permissions beyond those granted at install. */
  private async checkGrant(project: SpliceProject, pkg: LoadedPackage): Promise<void> {
    const granted = (await project.readLock()).packages[pkg.id]?.permissions;
    if (!granted) return; // lockfiles written before Phase 5 carry no grant record
    const ungranted = ungrantedPermissions(pkg.manifest.permissions, granted);
    if (!isEmptyPermissions(ungranted)) {
      throw new CoreError("PERMISSIONS_NOT_GRANTED", `${pkg.id} requests permissions that were not granted at install time`, {
        details: describePermissions(ungranted),
        hint: `Reinstall it to review the permissions: splice add ${pkg.id} --accept-permissions`,
      });
    }
  }

  async load(ref: string): Promise<LoadedPackage> {
    const project = await this.project();
    const id = await this.idFor(ref);
    try {
      const pkg = await loadPackage(project.packageDir(id));
      await assertInstalledIntact(project, id, (await project.readLock()).packages[id]);
      await this.checkGrant(project, pkg);
      return pkg;
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw new CoreError("INVALID_PACKAGE", `Installed package ${id} is missing or invalid.`, {
          details: error.details,
          hint: `Reinstall it with add("${id}").`,
        });
      }
      throw error;
    }
  }

  async installed(): Promise<LoadedPackage[]> {
    const project = await this.project();
    const loaded: LoadedPackage[] = [];
    for (const id of Object.keys((await project.readLock()).packages).sort()) {
      try {
        const pkg = await loadPackage(project.packageDir(id));
        await assertInstalledIntact(project, id, (await project.readLock()).packages[id]);
        await this.checkGrant(project, pkg);
        loaded.push(pkg);
      } catch {
        // Skipped: `list()` reports such packages as missing/invalid.
      }
    }
    return loaded;
  }
}

export type { AddOptions };
