import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeIntegrity,
  describePermissions,
  encodeTarGz,
  hostAllowed,
  isEmptyPermissions,
  normalizePermissions,
  redactSecrets,
  ungrantedPermissions,
  validateBundleFiles,
  validateManifest,
  verifyArtifact,
  type BundleFile,
  type Manifest,
  type PackageVerifier,
} from "./index.js";

const enc = new TextEncoder();
const baseManifest = () => ({
  specVersion: 1,
  namespace: "splice",
  name: "trusted",
  version: "1.0.0",
  description: "Trust fixture",
  permissions: { network: ["api.example.com"] },
  tools: [
    {
      name: "run",
      description: "run",
      entry: "tools/run.ts",
      input: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false },
      output: { type: "object" },
    },
  ],
});
const files = (manifest: object = baseManifest(), extra: BundleFile[] = []): BundleFile[] => [
  { path: "manifest.json", content: enc.encode(JSON.stringify(manifest)) },
  { path: "SKILL.md", content: enc.encode("# trusted\n\nDoes things.") },
  { path: "tools/run.ts", content: enc.encode("export default () => ({})") },
  ...extra,
];
const valid = (m: object = baseManifest()): Manifest => {
  const r = validateManifest(m);
  assert.ok(r.ok);
  return r.value;
};

async function artifact() {
  const bytes = encodeTarGz(files());
  return { bytes, integrity: await computeIntegrity(bytes) };
}

describe("verification pipeline", () => {
  it("verifies a genuine artifact and reports every check", async () => {
    const { bytes, integrity } = await artifact();
    const result = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity, size: bytes.length, manifest: valid() } });
    assert.equal(result.verified, true);
    assert.deepEqual(result.checks.map((c) => [c.id, c.status]), [
      ["sha256", "passed"],
      ["size", "passed"],
      ["package", "passed"],
      ["metadata", "passed"],
      ["signature", "skipped"],
    ]);
    assert.match(result.checks[4]!.message, /unsigned/);
    assert.equal(result.files?.length, 3);
  });

  it("fails closed on a modified artifact and does not decode it", async () => {
    const { bytes, integrity } = await artifact();
    const modified = new Uint8Array(bytes);
    modified[modified.length - 30] = modified[modified.length - 30]! ^ 0xff;
    const result = await verifyArtifact({ bytes: modified, expected: { id: "@splice/trusted", version: "1.0.0", integrity, size: bytes.length } });
    assert.equal(result.verified, false);
    assert.equal(result.checks[0]!.status, "failed");
    assert.ok(result.checks.slice(1).every((c) => c.status === "skipped" && /earlier check failed/.test(c.message)));
    assert.equal(result.files, undefined, "nothing is handed out for installation");
  });

  it("fails on a wrong or malformed SHA-256 and on a size mismatch", async () => {
    const { bytes, integrity } = await artifact();
    const wrong = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity: `sha256-${"0".repeat(64)}` } });
    assert.equal(wrong.verified, false);
    const malformed = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity: "md5-abc" } });
    assert.match(malformed.checks[0]!.message, /not a sha256 digest/);
    const size = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity, size: bytes.length + 1 } });
    assert.deepEqual(size.checks.map((c) => c.status).slice(0, 2), ["passed", "failed"]);
  });

  it("detects tampered registry metadata (manifest differs from the artifact)", async () => {
    const { bytes, integrity } = await artifact();
    const tampered = valid({ ...baseManifest(), permissions: {} }); // registry hides the network permission
    const result = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity, manifest: tampered } });
    assert.equal(result.verified, false);
    assert.equal(result.checks.find((c) => c.id === "metadata")!.status, "failed");
  });

  it("detects an artifact that belongs to a different package or version", async () => {
    const { bytes, integrity } = await artifact();
    const otherId = await verifyArtifact({ bytes, expected: { id: "@splice/other", version: "1.0.0", integrity } });
    assert.match(otherId.checks.find((c) => c.id === "package")!.message, /expected @splice\/other@1\.0\.0/);
    const otherVersion = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "2.0.0", integrity } });
    assert.equal(otherVersion.verified, false);
  });

  it("fails closed on signatures it cannot verify (signing-ready)", async () => {
    const { bytes, integrity } = await artifact();
    const result = await verifyArtifact({
      bytes,
      expected: { id: "@splice/trusted", version: "1.0.0", integrity, signatures: [{ algorithm: "ed25519", keyId: "k1", value: "AAAA" }] },
    });
    assert.equal(result.verified, false);
    assert.match(result.checks.find((c) => c.id === "signature")!.message, /unsupported signature algorithm/);
  });

  it("accepts custom verifiers (e.g. a future SignatureVerifier)", async () => {
    const { bytes, integrity } = await artifact();
    const deny: PackageVerifier = { id: "policy", verify: async () => ({ id: "policy", status: "failed", message: "blocked by policy" }) };
    const result = await verifyArtifact({ bytes, expected: { id: "@splice/trusted", version: "1.0.0", integrity } }, [deny]);
    assert.deepEqual(result.checks, [{ id: "policy", status: "failed", message: "blocked by policy" }]);
    assert.equal(result.verified, false);
  });
});

describe("publish validation", () => {
  const errors = (fs: BundleFile[]) => {
    const r = validateBundleFiles(fs);
    return r.ok ? [] : r.errors;
  };

  it("rejects malformed SKILL.md", () => {
    const withDoc = (content: Uint8Array) => files().map((f) => (f.path === "SKILL.md" ? { ...f, content } : f));
    assert.match(errors(withDoc(enc.encode("   \n")))[0]!, /SKILL\.md is empty/);
    assert.match(errors(withDoc(enc.encode("# a\0b")))[0]!, /NUL/);
    assert.match(errors(withDoc(new Uint8Array([0xff, 0xfe, 0xfd])))[0]!, /not valid UTF-8/);
    assert.match(errors(withDoc(new Uint8Array(300 * 1024).fill(0x61)))[0]!, /exceeds/);
  });

  it("rejects hidden files and node_modules so nothing bypasses validation", () => {
    for (const path of [".env", "tools/.secret", ".git/config", "node_modules/x/index.js"]) {
      assert.match(errors(files(baseManifest(), [{ path, content: enc.encode("x") }])).join("\n"), /disallowed file/, path);
    }
  });

  it("rejects invalid names, versions and tool schemas", () => {
    assert.match(errors(files({ ...baseManifest(), name: "Bad_Name" })).join("\n"), /name/);
    assert.match(errors(files({ ...baseManifest(), version: "1.0" })).join("\n"), /version/);
    const badSchema = { ...baseManifest(), tools: [{ ...baseManifest().tools[0]!, input: { type: "object", properties: { q: { type: "strng" } } } }] };
    assert.match(errors(files(badSchema)).join("\n"), /input\.properties\.q\.type/);
  });

  it("validates the reserved dependencies field", () => {
    assert.ok(validateManifest({ ...baseManifest(), dependencies: { "@splice/example": "^0.1.0" } }).ok);
    const cases: Array<[unknown, RegExp]> = [
      [["@splice/example"], /must be an object/],
      [{ "splice/example": "^1.0.0" }, /invalid package name/],
      [{ "@Splice/Example": "^1.0.0" }, /invalid package name/],
      [{ "@splice/example": "banana" }, /invalid version range/],
      [{ "@splice/example": "latest" }, /invalid version range/],
      [{ "@splice/trusted": "^1.0.0" }, /cannot depend on itself/],
    ];
    for (const [deps, pattern] of cases) {
      const r = validateManifest({ ...baseManifest(), dependencies: deps });
      assert.equal(r.ok, false, JSON.stringify(deps));
      assert.match(!r.ok ? r.errors.join("\n") : "", pattern);
    }
  });
});

describe("secret redaction (Phase 8)", () => {
  it("redacts known token formats, keys, auth headers, cookies and URL credentials", () => {
    const samples: Array<[string, string]> = [
      [`token splice_${"A".repeat(43)} end`, "AAAAAAAAAAAAAAAAAAAA"],
      [`ghp_${"x".repeat(36)}`, "xxxxxxxxxxxxxxxxxxxx"],
      [`github_pat_${"Y".repeat(40)}`, "YYYYYYYYYYYYYYYYYYYY"],
      [`key sk-ant-${"z".repeat(40)}`, "zzzzzzzzzzzzzzzzzzzz"],
      ["AKIAABCDEFGHIJKLMNOP leaked", "AKIAABCDEFGHIJKLMNOP"],
      ["Authorization: Bearer abc.def.ghi-123456", "abc.def.ghi-123456"],
      ["authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["Cookie: session=abc123; theme=dark", "session=abc123"],
      ["set-cookie: id=zz9", "id=zz9"],
      ["https://user:hunter2@example.com/path", "hunter2"],
      ["https://api.example.com/x?access_token=tok123&page=2", "tok123"],
      ["GITHUB_TOKEN=ghx123value", "ghx123value"],
      ["DB_PASSWORD = \"p@ss w\"", "p@ss"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
    ];
    for (const [text, secret] of samples) {
      const out = redactSecrets(text);
      assert.ok(!out.includes(secret), `${text} → ${out}`);
      assert.match(out, /\[REDACTED\]/, text);
    }
    assert.equal(redactSecrets("page=2&page_size=10 Error: ENOENT /tmp/x"), "page=2&page_size=10 Error: ENOENT /tmp/x", "ordinary text is untouched");
    const toolNames = "Unknown tool splice_github_search-repositories; see splice_http_get and splice_files_read";
    assert.equal(redactSecrets(toolNames), toolNames, "MCP tool names are not tokens");
  });

  it("redacts exact secret values (longest first), ignoring values too short to be safe", () => {
    assert.equal(redactSecrets("a my-secret-value b my-secret", ["my-secret", "my-secret-value"]), "a [REDACTED] b [REDACTED]");
    assert.equal(redactSecrets("id 42 ok", ["42"]), "id 42 ok");
    assert.equal(redactSecrets("x (a+b) y", ["(a+b) y"]), "x [REDACTED]", "regex characters are literal");
  });
});

describe("host capability permissions", () => {
  it("accepts known broker capabilities, rejects unknown ones, and omits the field when empty", () => {
    const errors: string[] = [];
    const p = normalizePermissions({ capabilities: ["web.search", "market.price", "web.search"] }, errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(p.capabilities, ["web.search", "market.price"]);
    assert.deepEqual(Object.keys(normalizePermissions({ network: ["a.com"] }, [])), ["fs", "network", "env"], "no capabilities key for older manifests");
    const bad: string[] = [];
    normalizePermissions({ capabilities: ["shell.exec", 42] }, bad);
    assert.equal(bad.length, 2);
    assert.match(bad[0]!, /must be one of: onchain\.balance/);
  });

  it("describes capabilities (billed ones say so) and requires consent for new ones", () => {
    const p = normalizePermissions({ capabilities: ["onchain.balance", "ai.generate"] }, []);
    const lines = describePermissions(p);
    assert.match(lines[0]!, /^host capability: onchain\.balance \(run by Splice with the host's provider keys/);
    assert.match(lines[1]!, /ai\.generate .* may spend provider credits\/money$/);
    const granted = normalizePermissions({ capabilities: ["onchain.balance"] }, []);
    assert.deepEqual(ungrantedPermissions(p, granted).capabilities, ["ai.generate"]);
    assert.equal(ungrantedPermissions(p, p).capabilities, undefined);
    assert.equal(isEmptyPermissions(normalizePermissions({ capabilities: ["web.search"] }, [])), false);
  });
});

describe("permission grants", () => {
  it("reports permissions that were not granted", () => {
    const requested = { fs: { read: ["data"], write: ["out"] }, network: ["a.com", "b.com"], env: ["TOKEN"] };
    const granted = { fs: { read: [], write: ["data", "out"] }, network: ["a.com"], env: [] };
    assert.deepEqual(ungrantedPermissions(requested, granted), { fs: { read: [], write: [] }, network: ["b.com"], env: ["TOKEN"] });
    assert.deepEqual(ungrantedPermissions(requested, requested), { fs: { read: [], write: [] }, network: [], env: [] });
  });

  it('accepts network "*" (any public host), describes it and keeps it an explicit grant', () => {
    const errors: string[] = [];
    const p = normalizePermissions({ network: ["*"] }, errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(p.network, ["*"]);
    assert.deepEqual(describePermissions(p), ["network: any public host (private, loopback and link-local addresses are blocked)"]);
    assert.equal(hostAllowed("anything.example", ["*"]), true);
    for (const bad of ["**", "*.", "*.*", "* ", "http://*"]) {
      const e: string[] = [];
      normalizePermissions({ network: [bad] }, e);
      assert.equal(e.length, 1, bad);
    }
    // "*" is not implied by a narrower grant, and a narrower request is not covered by "*" silently.
    assert.deepEqual(ungrantedPermissions(p, { fs: { read: [], write: [] }, network: ["api.github.com"], env: [] }).network, ["*"]);
  });
});
