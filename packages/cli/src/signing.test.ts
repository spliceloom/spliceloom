/**
 * Package signing end to end against a real registry over HTTP: keys generate/register (CLI),
 * publish --sign, install with --require-signed, tampered signature metadata, and signer changes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { RegistryService } from "@spliceloom/registry";
import { openLocalRegistry, serveRegistry, type RunningServer } from "@spliceloom/registry/node";
import { CoreError, Splice } from "@spliceloom/sdk";
import { main } from "./cli.js";

function writeSkill(root: string, version: string): string {
  const dir = join(root, `signed-${version}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# signed");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ specVersion: 1, namespace: "acme", name: "signed", version, description: "signing fixture", tools: [{ name: "hi", description: "hi", entry: "tools/hi.ts", input: { type: "object" } }] }),
  );
  writeFileSync(join(dir, "tools", "hi.ts"), "export default () => ({ hi: true })");
  return dir;
}

describe("package signing (real registry over HTTP)", () => {
  let root: string;
  let service: RegistryService;
  let server: RunningServer;
  let token: string;
  const env = () => ({ SPLICE_HOME: join(root, "home"), SPLICE_REGISTRY: server.url, SPLICE_TOKEN: token });

  async function cli(argv: string[], cwd = root) {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env: env(), color: false });
    return { code, stdout, stderr };
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-signing-"));
    service = openLocalRegistry(join(root, "registry"));
    await service.createUser("acme");
    token = (await service.createToken("acme")).token;
    server = await serveRegistry({ service, port: 0 });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const sdk = (project: string, fetchImpl?: typeof fetch) => new Splice({ project, registry: server.url, env: { SPLICE_HOME: join(root, "home") }, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

  it("generates a key, registers it, publishes and signs in one step", async () => {
    const generated = await cli(["keys", "generate"]);
    assert.equal(generated.code, 0, generated.stderr);
    assert.match(generated.stdout, /Created signing key default ed25519:[0-9a-f]{16}/);
    assert.equal((await cli(["keys", "generate"])).code, 1, "never overwrites a key");
    const keyFile = readFileSync(join(root, "home", "keys", "default.key"), "utf8");
    assert.match(keyFile, /BEGIN PRIVATE KEY/);

    // Registering needs the namespace to exist: the first publish claims it.
    const first = await cli(["publish", writeSkill(join(root, "src"), "1.0.0")]);
    assert.equal(first.code, 0, first.stderr);
    const registered = await cli(["keys", "register", "@acme"]);
    assert.equal(registered.code, 0, registered.stderr);
    const listed = await cli(["keys", "list", "@acme", "--json"]);
    assert.equal(JSON.parse(listed.stdout).keys.length, 1);

    const signed = await cli(["sign", "@acme/signed@1.0.0", "--dir", join(root, "src", "signed-1.0.0")]);
    assert.equal(signed.code, 0, signed.stderr);
    const published = await cli(["publish", writeSkill(join(root, "src"), "1.0.1"), "--sign"]);
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /signed by ed25519:/);
  });

  it("verifies signatures on install, records the signer in splice.lock and enforces --require-signed", async () => {
    const project = join(root, "p1");
    const splice = sdk(project);
    await splice.init();
    const added = await splice.add("@acme/signed@1.0.1", { requireSigned: true });
    assert.match(added.signedBy ?? "", /^ed25519:[0-9a-f]{16}$/);
    const lock = JSON.parse(readFileSync(join(project, "splice.lock"), "utf8"));
    assert.equal(lock.packages["@acme/signed"].signedBy, added.signedBy);

    const out = await cli(["add", "@acme/signed@1.0.0", "--require-signed"], project);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /signature: verified, signed by ed25519:/);
  });

  it("refuses tampered signature metadata, even without --require-signed", async () => {
    const forged: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!/\/packages\/acme\/signed\/1\.0\.1$/.test(String(input))) return response;
      const body = (await response.json()) as { signatures: Array<{ signature: string }> };
      body.signatures[0]!.signature = `${"A".repeat(86)}==`;
      return Response.json(body);
    };
    const splice = sdk(join(root, "p2"), forged);
    await splice.init();
    await assert.rejects(splice.add("@acme/signed@1.0.1"), (e: unknown) => e instanceof CoreError && e.code === "SIGNATURE_INVALID");
  });

  it("refuses an unsigned update of a signed package unless the signer change is allowed", async () => {
    const project = join(root, "p1");
    assert.equal((await cli(["publish", writeSkill(join(root, "src"), "1.0.2")])).code, 0);
    await assert.rejects(sdk(project).add("@acme/signed@1.0.2"), (e: unknown) => e instanceof CoreError && e.code === "SIGNER_CHANGED");
    await assert.rejects(sdk(project).add("@acme/signed@1.0.2", { requireSigned: true, allowSignerChange: true }), (e: unknown) => e instanceof CoreError && e.code === "SIGNATURE_REQUIRED");
    const allowed = await sdk(project).add("@acme/signed@1.0.2", { allowSignerChange: true });
    assert.equal(allowed.signedBy, undefined);
    assert.equal(JSON.parse(readFileSync(join(project, "splice.lock"), "utf8")).packages["@acme/signed"].signedBy, undefined);
  });

  it("does not sign bytes that differ from the local source", async () => {
    const other = writeSkill(join(root, "mismatch"), "1.0.2");
    writeFileSync(join(other, "tools", "hi.ts"), "export default () => ({ hi: false })");
    const refused = await cli(["sign", "@acme/signed@1.0.2", "--dir", other]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Not signing/);
  });
});
