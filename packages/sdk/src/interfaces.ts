/**
 * The SDK is composed of four small interfaces. `Splice` wires the default implementations
 * together; each one can be replaced (e.g. in tests or in a host with its own runtime).
 */
import type { AddOptions, AddResult, InstalledPackage, OutdatedPackage, UpdateOptions, UpdateResult } from "@spliceloom/core";
import type { LoadedPackage, ToolResult } from "@spliceloom/runtime";

/** Resolves a package reference (`@ns/name`, `@ns/name@^1.0.0`) to a concrete registry version. */
export interface PackageResolver {
  resolve(ref: string): Promise<{ id: string; version: string }>;
}

/** Installs, removes and lists packages of a project. Never executes package code. */
export interface PackageManager {
  add(ref: string, options?: AddOptions): Promise<AddResult>;
  remove(id: string): Promise<{ id: string; version: string | null }>;
  list(): Promise<InstalledPackage[]>;
  /** Installs everything recorded in splice.lock / splice.json (Phase 6; optional for custom managers). */
  install?(options?: AddOptions): Promise<AddResult[]>;
  /** Locked vs. registry versions (Phase 6; optional for custom managers). */
  outdated?(ids?: string[]): Promise<OutdatedPackage[]>;
  /** Updates within splice.json ranges (Phase 6; optional for custom managers). */
  update?(ids?: string[], options?: UpdateOptions): Promise<UpdateResult[]>;
}

/** Loads installed packages (validated) from a project. */
export interface SkillLoader {
  /** `@ns/name` or the short name (`name`) when unambiguous. */
  load(ref: string): Promise<LoadedPackage>;
  /** Every installed package that loads and validates. */
  installed(): Promise<LoadedPackage[]>;
}

/** Executes a tool of a loaded package. The default is the sandboxed Splice runtime. */
export interface SkillRuntime {
  execute(pkg: LoadedPackage, tool: string, input?: unknown): Promise<ToolResult>;
}
