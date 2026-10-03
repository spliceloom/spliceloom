import type { AddOptions, AddResult } from "@spliceloom/sdk";
import { describePermissions, parsePackageId, parsePackageRef } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, shortName, spliceFor } from "./shared.js";

export interface SigningFlags {
  requireSigned?: boolean;
  allowSignerChange?: boolean;
}

function installOptions(ctx: Context, acceptPermissions: boolean, signing: SigningFlags = {}): AddOptions {
  return {
    acceptPermissions,
    ...(signing.requireSigned ? { requireSigned: true } : {}),
    ...(signing.allowSignerChange ? { allowSignerChange: true } : {}),
    onStep: (step, detail) => {
      if (ctx.json) return;
      const label = { resolving: "Resolving", downloading: "Downloading", verifying: "Verifying", installing: "Installing" }[step];
      ctx.err(ctx.style.dim(`${label} ${detail}...`));
    },
  };
}

function printInstalled(ctx: Context, result: AddResult): void {
  const s = ctx.style;
  if (result.alreadyInstalled) {
    ctx.out(`${result.id}@${result.version} is already installed`);
    return;
  }
  const change = result.previousVersion ? ` (was ${result.previousVersion})` : "";
  ctx.out(`${s.green("Installed")} ${s.bold(`${result.id}@${result.version}`)}${change}`);
  if (result.offline) ctx.out(s.yellow(`  offline: installed from the local cache, verified against splice.lock (${result.integrity})`));
  ctx.out(`  signature: ${result.signedBy ? s.green(`verified, signed by ${result.signedBy}`) : s.dim("unsigned (SHA-256 verified)")}`);
  ctx.out(`  permissions: ${describePermissions(result.manifest.permissions).join("; ")}`);
  ctx.out(`  tools: ${result.manifest.tools.map((t) => `${shortName(result.id)}.${t.name}`).join(", ")}`);
}

function installedJson(results: AddResult[]): unknown {
  return results.map((r) => ({
    name: r.id,
    version: r.version,
    integrity: r.integrity,
    alreadyInstalled: r.alreadyInstalled,
    previousVersion: r.previousVersion ?? null,
    fromCache: r.fromCache === true,
    offline: r.offline === true,
    signedBy: r.signedBy ?? null,
    permissions: r.manifest.permissions,
    tools: r.manifest.tools.map((t) => t.name),
  }));
}

export async function addCommand(ctx: Context, positionals: string[], acceptPermissions = false, signing: SigningFlags = {}): Promise<number> {
  if (positionals.length === 0) {
    throw new UsageError("add requires a package", "Example: splice add @splice/example (to install everything in splice.lock: splice install)");
  }
  positionals.forEach((ref) => parsePackageRef(ref));
  const splice = spliceFor(ctx);
  const results: AddResult[] = [];

  for (const ref of positionals) {
    const result = await splice.add(ref, installOptions(ctx, acceptPermissions, signing));
    results.push(result);
    if (!ctx.json) printInstalled(ctx, result);
  }

  if (ctx.json) printJson(ctx, installedJson(results));
  return 0;
}

export async function installCommand(ctx: Context, positionals: string[], acceptPermissions = false, signing: SigningFlags = {}): Promise<number> {
  if (positionals.length > 0) {
    throw new UsageError("install takes no packages", `To add a package: splice add ${positionals[0]}`);
  }
  const results = await spliceFor(ctx).install(installOptions(ctx, acceptPermissions, signing));
  if (ctx.json) {
    printJson(ctx, installedJson(results));
    return 0;
  }
  if (results.length === 0) {
    ctx.out("Nothing to install: splice.json has no packages.");
    return 0;
  }
  for (const result of results) printInstalled(ctx, result);
  const changed = results.filter((r) => !r.alreadyInstalled).length;
  ctx.out(ctx.style.dim(`${results.length} package(s) match splice.lock (${changed} installed, ${results.length - changed} already up to date)`));
  return 0;
}

export async function outdatedCommand(ctx: Context, positionals: string[]): Promise<number> {
  positionals.forEach((id) => parsePackageId(id));
  const packages = await spliceFor(ctx).outdated(positionals);
  if (ctx.json) {
    printJson(ctx, packages);
    return 0;
  }
  if (packages.length === 0) {
    ctx.out("No packages in splice.json.");
    return 0;
  }
  const s = ctx.style;
  const rows = [["Package", "Current", "Wanted", "Latest", "Range", ""]].concat(
    packages.map((p) => [
      p.id,
      p.current ?? "-",
      p.wanted ?? "-",
      p.latest ?? "-",
      p.range ?? "-",
      { "up-to-date": "up to date", "update-available": "update available", "not-installed": "not installed", "no-match": "no matching version" }[p.status],
    ]),
  );
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  rows.forEach((row, index) => {
    const line = row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd();
    ctx.out(index === 0 ? s.bold(line) : packages[index - 1]!.status === "up-to-date" ? line : s.yellow(line));
  });
  const pending = packages.filter((p) => p.status === "update-available" || p.status === "not-installed").length;
  const beyond = packages.filter((p) => p.latest && p.wanted && p.latest !== p.wanted);
  ctx.out();
  ctx.out(pending === 0 ? "All packages are up to date within their ranges." : `${pending} package(s) can be updated: splice update`);
  for (const p of beyond) ctx.out(s.dim(`${p.id}@${p.latest} is outside "${p.range}"; to move to it: splice add ${p.id}@^${p.latest}`));
  return 0;
}

export async function updateCommand(ctx: Context, positionals: string[], acceptPermissions = false, signing: SigningFlags = {}): Promise<number> {
  positionals.forEach((id) => parsePackageId(id));
  const results = await spliceFor(ctx).update(positionals, installOptions(ctx, acceptPermissions, signing));
  const noMatch = results.filter((r) => r.status === "no-match");
  if (ctx.json) {
    printJson(ctx, results);
    return noMatch.length > 0 ? 1 : 0;
  }
  const s = ctx.style;
  if (results.length === 0) {
    ctx.out("No packages in splice.json.");
    return 0;
  }
  for (const r of results) {
    if (r.status === "updated") ctx.out(`${s.green("Updated")} ${s.bold(r.id)} ${r.from ?? "(not installed)"} -> ${r.to}`);
    else if (r.status === "up-to-date") ctx.out(`${r.id}@${r.to} is up to date (range "${r.range}")`);
    else ctx.out(s.yellow(`${r.id}: no registry version satisfies "${r.range}"${r.latest ? ` (latest: ${r.latest})` : ""}; nothing changed`));
    if (r.latest && r.to && r.latest !== r.to) ctx.out(s.dim(`  ${r.id}@${r.latest} is outside "${r.range}"; to move to it: splice add ${r.id}@^${r.latest}`));
  }
  if (results.every((r) => r.status === "up-to-date")) ctx.out("Everything is up to date. splice.lock was not changed.");
  return noMatch.length > 0 ? 1 : 0;
}

export async function removeCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length === 0) throw new UsageError("remove requires a package", "Example: splice remove @splice/example");
  positionals.forEach((id) => parsePackageId(id));
  const splice = spliceFor(ctx);
  for (const id of positionals) {
    const removed = await splice.remove(id);
    ctx.out(`${ctx.style.green("Removed")} ${removed.id}${removed.version ? `@${removed.version}` : ""}`);
  }
  return 0;
}

export async function listCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length > 0) throw new UsageError("list takes no arguments");
  const packages = await spliceFor(ctx).list();
  if (ctx.json) {
    printJson(ctx, packages.map((p) => ({ name: p.id, version: p.version, range: p.range, status: p.status })));
    return 0;
  }
  if (packages.length === 0) {
    ctx.out("No packages installed. Run `splice add <package>` to install one.");
    return 0;
  }
  const width = Math.max(...packages.map((p) => p.id.length));
  for (const p of packages) {
    const status =
      p.status === "ok" ? "" : "  " + ctx.style.yellow(p.status === "missing" ? "(missing - run splice add)" : "(invalid - reinstall)");
    ctx.out(`${p.id.padEnd(width)}  ${p.version ?? "-"}${status}`);
  }
  return 0;
}
