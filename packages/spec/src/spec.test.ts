import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SpecError,
  checkSchemaDefinition,
  compareVersions,
  computeIntegrity,
  decodeBundle,
  describeTools,
  encodeBundle,
  hostAllowed,
  latestVersion,
  maxSatisfying,
  parseManifest,
  parsePackageRef,
  parseToolRef,
  satisfies,
  validateBundleFiles,
  validateManifest,
  validateValue,
  type BundleFile,
} from "./index.js";

const validManifest = () => ({
  specVersion: 1,
  namespace: "splice",
  name: "example",
  version: "0.1.0",
  description: "Example",
  permissions: {},
  tools: [
    {
      name: "hello",
      description: "Say hello",
      entry: "tools/hello.ts",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      output: { type: "object", properties: { message: { type: "string" } } },
    },
  ],
});

describe("manifest validation", () => {
  it("accepts a valid manifest and normalizes defaults", () => {
    const result = validateManifest(validManifest());
    assert.ok(result.ok);
    assert.equal(result.value.runtime.type, "node");
    assert.deepEqual(result.value.permissions, { fs: { read: [], write: [] }, network: [], env: [] });
  });

  it("rejects unsupported spec versions", () => {
    const result = validateManifest({ ...validManifest(), specVersion: 2 });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.errors[0]! : "", /unsupported version 2/);
  });

  it("reports every problem at once", () => {
    const result = validateManifest({
      ...validManifest(),
      name: "Bad Name",
      version: "1.0",
      extra: true,
      tools: [{ name: "Hello", description: "", entry: "../escape.ts", input: { type: "string" } }],
    });
    assert.equal(result.ok, false);
    const text = !result.ok ? result.errors.join("\n") : "";
    for (const fragment of ["name:", "version:", "extra: unknown field", "tools[0].name", "tools[0].description", "tools[0].entry", "input.type"]) {
      assert.ok(text.includes(fragment), `expected error mentioning ${fragment}\n${text}`);
    }
  });

  it("accepts manifest text with a UTF-8 byte order mark", () => {
    const bom = String.fromCharCode(0xfeff);
    assert.ok(parseManifest(bom + JSON.stringify(validManifest())).ok);
  });

  it("accepts the optional runtime.minNodeVersion (backward compatible)", () => {
    const withMin = validateManifest({ ...validManifest(), runtime: { type: "node", minNodeVersion: "22.18.0" } });
    assert.ok(withMin.ok);
    assert.equal(withMin.value.runtime.minNodeVersion, "22.18.0");
    assert.equal(validateManifest(validManifest()).ok && validateManifest(validManifest()).ok, true);
    const bad = validateManifest({ ...validManifest(), runtime: { type: "node", minNodeVersion: ">=22", gpu: true } });
    assert.equal(bad.ok, false);
    const text = !bad.ok ? bad.errors.join("\n") : "";
    assert.match(text, /minNodeVersion/);
    assert.match(text, /runtime\.gpu: unknown field/);
  });

  it("describes tools with a stable contract", () => {
    const result = validateManifest(validManifest());
    assert.ok(result.ok);
    const [tool] = describeTools(result.value);
    assert.deepEqual(
      { name: tool!.name, qualifiedName: tool!.qualifiedName, mcpName: tool!.mcpName, timeoutMs: tool!.timeoutMs },
      { name: "example.hello", qualifiedName: "@splice/example.hello", mcpName: "splice_example_hello", timeoutMs: 10_000 },
    );
    assert.deepEqual(tool!.inputSchema, validManifest().tools[0]!.input);
    assert.deepEqual(tool!.outputSchema, validManifest().tools[0]!.output);
  });

  it("allows x- extension fields", () => {
    assert.ok(validateManifest({ ...validManifest(), "x-vendor": { a: 1 } }).ok);
  });

  it("rejects duplicate tools and unsafe permissions", () => {
    const m = validManifest();
    m.tools.push({ ...m.tools[0]! });
    const result = validateManifest({
      ...m,
      permissions: { fs: { read: ["../secrets"], write: ["/etc"] }, network: ["HTTP://x"], env: ["lower"], shell: true },
    });
    assert.equal(result.ok, false);
    const text = !result.ok ? result.errors.join("\n") : "";
    assert.match(text, /duplicate tool name/);
    assert.match(text, /fs\.read\[0\]/);
    assert.match(text, /fs\.write\[0\]/);
    assert.match(text, /network\[0\]/);
    assert.match(text, /env\[0\]/);
    assert.match(text, /unknown permission "shell"/);
  });
});

describe("names", () => {
  it("parses package references with ranges", () => {
    assert.deepEqual(parsePackageRef("@splice/example"), { namespace: "splice", name: "example", id: "@splice/example", range: "latest" });
    assert.equal(parsePackageRef("@splice/example@^0.1.0").range, "^0.1.0");
    assert.throws(() => parsePackageRef("example"), SpecError);
    assert.throws(() => parsePackageRef("@Splice/example"), SpecError);
    assert.throws(() => parsePackageRef("@splice/example@banana"), /Invalid version range/);
  });

  it("parses tool references", () => {
    assert.deepEqual(parseToolRef("example.hello"), { name: "example", tool: "hello" });
    assert.deepEqual(parseToolRef("@splice/example.hello"), { namespace: "splice", name: "example", tool: "hello" });
    assert.throws(() => parseToolRef("example"), /Invalid tool reference/);
    assert.throws(() => parseToolRef("example."), SpecError);
  });
});

describe("semver", () => {
  it("compares versions including prereleases", () => {
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  });

  it("matches caret, tilde, exact and latest ranges", () => {
    assert.ok(satisfies("1.4.0", "^1.2.0"));
    assert.ok(!satisfies("2.0.0", "^1.2.0"));
    assert.ok(satisfies("0.1.9", "^0.1.0"));
    assert.ok(!satisfies("0.2.0", "^0.1.0"));
    assert.ok(!satisfies("0.0.2", "^0.0.1"));
    assert.ok(satisfies("1.2.9", "~1.2.3"));
    assert.ok(!satisfies("1.3.0", "~1.2.3"));
    assert.ok(satisfies("1.0.0-beta.1", "1.0.0-beta.1"));
    assert.ok(!satisfies("1.0.0-beta.1", "latest"));
  });

  it("selects the best version", () => {
    const versions = ["0.1.0", "0.1.2", "0.2.0", "1.0.0-rc.1"];
    assert.equal(maxSatisfying(versions, "^0.1.0"), "0.1.2");
    assert.equal(maxSatisfying(versions, "latest"), "0.2.0");
    assert.equal(maxSatisfying(versions, "^3.0.0"), null);
    assert.equal(latestVersion(versions), "0.2.0");
    assert.equal(latestVersion(["1.0.0-rc.1", "1.0.0-rc.2"]), "1.0.0-rc.2");
  });
});

describe("schema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      name: { type: "string" as const, minLength: 1, maxLength: 5 },
      count: { type: "integer" as const, minimum: 0 },
      mode: { enum: ["a", "b"] },
      tags: { type: "array" as const, items: { type: "string" as const }, maxItems: 2 },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("validates values", () => {
    assert.deepEqual(validateValue(schema, { name: "dim", count: 2, mode: "a", tags: ["x"] }), []);
    const errors = validateValue(schema, { count: 1.5, mode: "c", tags: ["x", 1, "z"], extra: 1 });
    assert.ok(errors.some((e) => e.includes("$.name: is required")));
    assert.ok(errors.some((e) => e.includes("$.count: expected integer")));
    assert.ok(errors.some((e) => e.includes("$.mode: must be one of")));
    assert.ok(errors.some((e) => e.includes("$.tags[1]: expected string")));
    assert.ok(errors.some((e) => e.includes("$.tags: must contain at most 2")));
    assert.ok(errors.some((e) => e.includes("$.extra: unknown property")));
  });

  it("rejects unsupported keywords", () => {
    assert.deepEqual(checkSchemaDefinition(schema), []);
    assert.match(checkSchemaDefinition({ type: "object", pattern: "x" }).join(), /unsupported keyword "pattern"/);
  });
});

describe("permissions", () => {
  it("matches host patterns", () => {
    assert.ok(hostAllowed("api.github.com", ["api.github.com"]));
    assert.ok(hostAllowed("a.example.com", ["*.example.com"]));
    assert.ok(!hostAllowed("example.com", ["*.example.com"]));
    assert.ok(!hostAllowed("evil-example.com", ["*.example.com"]));
    assert.ok(!hostAllowed("github.com", ["api.github.com"]));
  });
});

describe("bundle", () => {
  const enc = new TextEncoder();
  const files = (): BundleFile[] => [
    { path: "tools/hello.ts", content: enc.encode("export default () => ({})") },
    { path: "manifest.json", content: enc.encode(JSON.stringify(validManifest())) },
    { path: "SKILL.md", content: enc.encode("# Example") },
  ];

  it("round-trips deterministically", async () => {
    const a = encodeBundle(files());
    const b = encodeBundle([...files()].reverse());
    assert.deepEqual(a, b);
    assert.equal(await computeIntegrity(a), await computeIntegrity(b));
    assert.match(await computeIntegrity(a), /^sha256-[0-9a-f]{64}$/);
    const decoded = decodeBundle(a);
    assert.deepEqual(decoded.map((f) => f.path), ["SKILL.md", "manifest.json", "tools/hello.ts"]);
    assert.ok(validateBundleFiles(decoded).ok);
  });

  it("rejects unsafe or malformed bundles", () => {
    assert.throws(() => encodeBundle([{ path: "../x", content: new Uint8Array() }]), /Unsafe file path/);
    const evil = enc.encode(JSON.stringify({ format: "splice-bundle", formatVersion: 1, files: [{ path: "a/../../x", content: "" }] }));
    assert.throws(() => decodeBundle(evil), /Unsafe file path/);
    const dup = enc.encode(JSON.stringify({ format: "splice-bundle", formatVersion: 1, files: [{ path: "A.md", content: "" }, { path: "a.md", content: "" }] }));
    assert.throws(() => decodeBundle(dup), /Duplicate/);
    assert.throws(() => decodeBundle(enc.encode("nope")), /not valid UTF-8 JSON/);
    assert.throws(() => decodeBundle(enc.encode('{"format":"zip"}')), /Not a Splice bundle/);
  });

  it("requires SKILL.md and tool entry files", () => {
    const result = validateBundleFiles(files().filter((f) => f.path === "manifest.json"));
    assert.equal(result.ok, false);
    const text = !result.ok ? result.errors.join("\n") : "";
    assert.match(text, /SKILL\.md is missing/);
    assert.match(text, /entry file "tools\/hello\.ts" is missing/);
  });
});
