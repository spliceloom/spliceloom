import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  SpecError,
  archiveFormat,
  computeIntegrity,
  decodePackageArchive,
  encodeBundle,
  encodeTarGz,
  validateBundleFiles,
  type BundleFile,
} from "./index.js";

const enc = new TextEncoder();
const manifest = {
  specVersion: 1,
  namespace: "splice",
  name: "example",
  version: "0.1.0",
  description: "Example",
  tools: [{ name: "hello", description: "hi", entry: "tools/hello.ts", input: { type: "object" } }],
};
const files = (): BundleFile[] => [
  { path: "tools/hello.ts", content: enc.encode("export default () => ({})") },
  { path: "manifest.json", content: enc.encode(JSON.stringify(manifest)) },
  { path: "SKILL.md", content: enc.encode("# Example") },
];

/** Minimal ustar header writer for crafting hostile archives in tests. */
function header(name: string, size: number, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc.encode(name), 0);
  h.set(enc.encode("0000644\0"), 100);
  h.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\0"), 257);
  h.set(enc.encode("00"), 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

function tarOf(entries: Array<{ name: string; data?: string; type?: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = enc.encode(e.data ?? "");
    parts.push(header(e.name, data.length, e.type));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(parts));
}

describe("package archive (.tar.gz)", () => {
  it("is deterministic regardless of input order", async () => {
    const a = encodeTarGz(files());
    const b = encodeTarGz([...files()].reverse());
    assert.deepEqual(a, b);
    assert.equal(await computeIntegrity(a), await computeIntegrity(b));
    assert.equal(archiveFormat(a), "tar.gz");
  });

  it("round-trips through the decoder and validates", async () => {
    const decoded = await decodePackageArchive(encodeTarGz(files()));
    assert.deepEqual(decoded.map((f) => f.path), ["SKILL.md", "manifest.json", "tools/hello.ts"]);
    assert.equal(new TextDecoder().decode(decoded[2]!.content), "export default () => ({})");
    assert.ok(validateBundleFiles(decoded).ok);
  });

  it("is a standard gzip + ustar archive", () => {
    const tar = gunzipSync(encodeTarGz(files()));
    assert.equal(tar.length % 512, 0);
    assert.equal(tar.subarray(257, 262).toString(), "ustar");
    assert.equal(tar.subarray(0, 8).toString(), "SKILL.md");
  });

  it("handles long paths and large (multi-block) files", async () => {
    const longPath = `${"d".repeat(90)}/${"e".repeat(60)}/file.txt`;
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    const decoded = await decodePackageArchive(encodeTarGz([{ path: longPath, content: new Uint8Array([1, 2, 3]) }, { path: "big.bin", content: big }]));
    assert.equal(decoded.find((f) => f.path === longPath)?.content.length, 3);
    assert.deepEqual(decoded.find((f) => f.path === "big.bin")?.content, big);
  });

  it("reads archives produced by other gzip implementations", async () => {
    const decoded = await decodePackageArchive(new Uint8Array(gzipSync(tarOf([{ name: "./manifest.json", data: "{}" }, { name: "dir/", type: "5" }]))));
    assert.deepEqual(decoded.map((f) => f.path), ["manifest.json"]);
  });

  it("still reads legacy JSON bundles", async () => {
    const legacy = encodeBundle(files());
    assert.equal(archiveFormat(legacy), "json-bundle");
    assert.equal((await decodePackageArchive(legacy)).length, 3);
  });

  it("rejects path traversal, links, duplicates and corruption", async () => {
    const hostile: Array<[string, Uint8Array]> = [
      ["traversal", tarOf([{ name: "../../etc/passwd", data: "x" }])],
      ["absolute", tarOf([{ name: "/etc/passwd", data: "x" }])],
      ["symlink", tarOf([{ name: "link", type: "2" }])],
      ["hardlink", tarOf([{ name: "link", type: "1" }])],
      ["pax", tarOf([{ name: "pax", type: "x", data: "path=../../x" }])],
      ["duplicate", tarOf([{ name: "A.md", data: "1" }, { name: "a.md", data: "2" }])],
    ];
    for (const [label, tar] of hostile) {
      await assert.rejects(decodePackageArchive(new Uint8Array(gzipSync(tar))), SpecError, label);
    }
    const good = encodeTarGz(files());
    const flipped = new Uint8Array(good);
    flipped[20] = flipped[20]! ^ 0xff; // corrupt a header byte inside the stored block
    await assert.rejects(decodePackageArchive(flipped), SpecError);
    await assert.rejects(decodePackageArchive(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), /not valid gzip/);
  });

  it("rejects decompression bombs", async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
    assert.ok(bomb.length < 5 * 1024 * 1024);
    await assert.rejects(decodePackageArchive(bomb), /expands beyond/);
  });

  it("refuses to encode unsafe paths", () => {
    assert.throws(() => encodeTarGz([{ path: "../x", content: new Uint8Array() }]), /Unsafe/);
    assert.throws(() => encodeTarGz([{ path: "a", content: new Uint8Array() }, { path: "A", content: new Uint8Array() }]), /Duplicate/);
  });
});
