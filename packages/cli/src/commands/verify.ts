import { parsePackageRef } from "@spliceloom/spec";
import { UsageError, type Context } from "../io.js";
import { printJson, spliceFor } from "./shared.js";

/** `splice verify <package>[@version]`: factual verification of a published version. Exit 1 when a check fails. */
export async function verifyCommand(ctx: Context, positionals: string[]): Promise<number> {
  if (positionals.length !== 1) throw new UsageError("verify requires exactly one package", "Example: splice verify @splice/example@0.1.1");
  parsePackageRef(positionals[0]!);
  const report = await spliceFor(ctx).verify(positionals[0]!);
  if (ctx.json) {
    printJson(ctx, report);
    return report.verified ? 0 : 1;
  }
  const s = ctx.style;
  const status = report.verified ? s.green("VERIFIED") : s.red("FAILED");
  ctx.out(`${s.bold(`${report.package}@${report.version}`)}  ${status}`);
  ctx.out(`publisher:   ${report.publisher}`);
  ctx.out(`published:   ${report.publishedAt}`);
  ctx.out(`artifact:    ${report.artifact.filename ?? "-"} (${report.artifact.size} bytes${report.artifact.backend ? `, ${report.artifact.backend}` : ""})`);
  if (report.artifact.url) ctx.out(`url:         ${report.artifact.url}`);
  ctx.out(`sha256:      ${report.artifact.integrity}`);
  ctx.out(`provenance:  ${report.provenance ? (report.provenance.recorded ? "recorded at publish" : "derived (published before provenance existed)") : "not reported"}`);
  ctx.out("checks:");
  const label = { passed: s.green("pass"), failed: s.red("FAIL"), skipped: s.dim("skip") } as const;
  for (const check of report.checks) ctx.out(`  [${label[check.status]}] ${check.id.padEnd(10)} ${check.message}`);
  const signed = report.checks.some((c) => c.id === "signature" && c.status === "passed");
  ctx.out(
    s.dim(
      signed
        ? "SHA-256 verifies integrity; the signature shows which key registered for the namespace signed these exact bytes."
        : "SHA-256 verifies integrity (the bytes are the ones the registry recorded), not who wrote the package: this version is unsigned.",
    ),
  );
  return report.verified ? 0 : 1;
}
