import { RegistryClient, SpliceProject, resolveRegistry, type RegistrySource } from "@spliceloom/core";
import { Splice, type SpliceOptions } from "@spliceloom/sdk";
import type { Context } from "../io.js";

/** Resolves the registry for the current directory: --registry, env, splice.json, user config, default. */
export async function resolveContextRegistry(ctx: Context): Promise<{ url: string; source: RegistrySource }> {
  const project = await SpliceProject.find(ctx.io.cwd);
  const projectRegistry = project ? (await project.readConfig()).registry : undefined;
  return resolveRegistry({ override: ctx.registry, env: ctx.io.env, projectRegistry });
}

export async function registryFor(ctx: Context): Promise<RegistryClient> {
  return new RegistryClient((await resolveContextRegistry(ctx)).url, ctx.io.fetch);
}

/** SDK instance for this invocation: the CLI's package/registry/runtime commands go through it. */
export function spliceFor(ctx: Context): Splice {
  const options: SpliceOptions = { project: ctx.io.cwd, env: ctx.io.env };
  if (ctx.registry) options.registry = ctx.registry;
  if (ctx.io.fetch) options.fetch = ctx.io.fetch;
  return new Splice(options);
}

export function printJson(ctx: Context, value: unknown): void {
  ctx.out(JSON.stringify(value, null, 2));
}

/** Short name used in tool references: `@splice/example` → `example`. */
export function shortName(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}
