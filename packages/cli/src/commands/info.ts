import { SpliceProject } from "@spliceloom/core";
import { checkSignatures, describePermissions, parsePackageRef } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, spliceFor } from "./shared.js";

export async function infoCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length !== 1) throw new UsageError("info requires exactly one package", "Example: splice info @splice/example");
  const ref = parsePackageRef(positionals[0]!);
  const { package: pkg, version: detail, tools } = await spliceFor(ctx).info(positionals[0]!);

  const project = await SpliceProject.find(ctx.io.cwd);
  const installed = project ? ((await project.readLock()).packages[ref.id]?.version ?? null) : null;

  if (ctx.json) {
    printJson(ctx, { ...pkg, selected: detail, tools, installed });
    return 0;
  }

  const m = detail.manifest;
  const s = ctx.style;
  ctx.out(`${s.bold(pkg.name)} ${s.cyan(detail.version)}`);
  ctx.out(m.description);
  ctx.out();
  ctx.out(`latest:      ${pkg.latest}`);
  ctx.out(`versions:    ${pkg.versions.map((v) => v.version).join(", ")}`);
  if (m.license) ctx.out(`license:     ${m.license}`);
  if (m.homepage) ctx.out(`homepage:    ${m.homepage}`);
  ctx.out(`published:   ${detail.publishedAt}`);
  ctx.out(`integrity:   ${detail.integrity}`);
  ctx.out(`size:        ${detail.size} bytes`);
  // Checked locally: a signature that does not verify is reported, never shown as signed.
  const check = await checkSignatures(pkg.name, detail.version, detail.integrity, detail.signatures);
  ctx.out(`signature:   ${check.status === "verified" ? s.green(`verified, signed by ${check.keyId}`) : check.status === "invalid" ? s.red(`INVALID — ${check.reason}`) : s.dim("unsigned")}`);
  if (project) ctx.out(`installed:   ${installed ?? "no"}`);
  ctx.out();
  ctx.out(s.bold("Permissions"));
  for (const line of describePermissions(m.permissions)) ctx.out(`  ${line}`);
  ctx.out();
  ctx.out(s.bold("Tools"));
  for (const tool of tools) {
    ctx.out(`  ${s.cyan(tool.name)}  ${tool.description}`);
    const props = Object.entries(tool.inputSchema.properties ?? {});
    const required = new Set(tool.inputSchema.required ?? []);
    for (const [name, schema] of props) {
      const flag = required.has(name) ? "" : "?";
      const desc = schema.description ? `  ${s.dim(schema.description)}` : "";
      ctx.out(`      ${name}${flag}: ${schema.type ?? "any"}${desc}`);
    }
  }
  return 0;
}
