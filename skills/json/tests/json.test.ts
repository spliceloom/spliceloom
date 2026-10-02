/**
 * Unit tests for @splice/json. Self-contained (node:test, no Splice imports): run with
 *   node --test tests/*.test.ts
 * Sandbox-level behaviour is covered by the Splice repository's integration tests.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import parse from "../tools/parse.ts";
import pick, { parsePath } from "../tools/pick.ts";
import stringify from "../tools/stringify.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tools: Record<string, (input: never) => unknown> = { parse, stringify, pick };

describe("@splice/json", () => {
  it("parses valid JSON and reports its type", () => {
    assert.deepEqual(parse({ text: '{"a":[1,true,null]}' }), { value: { a: [1, true, null] }, type: "object" });
    assert.deepEqual(parse({ text: "[]" }), { value: [], type: "array" });
    assert.deepEqual(parse({ text: '"x"' }), { value: "x", type: "string" });
    assert.deepEqual(parse({ text: " 42 " }), { value: 42, type: "number" });
    assert.deepEqual(parse({ text: "null" }), { value: null, type: "null" });
  });

  it("rejects invalid JSON with a structured, positioned error", () => {
    assert.throws(() => parse({ text: '{"a": }' }), /^Error: INVALID_JSON: at position 6 \(line 1, column 7\)/);
    assert.throws(() => parse({ text: '{\n  "a": 1,\n  "b": x\n}' }), /INVALID_JSON: at position 19 \(line 3, column 8\)/);
    assert.throws(() => parse({ text: "" }), /^Error: INVALID_JSON: unexpected end of input/);
    assert.throws(() => parse({ text: '{"a": [1, 2' }), /^Error: INVALID_JSON: unexpected end of input/);
    assert.throws(() => parse({ text: "{'a':1}" }), /^Error: INVALID_JSON: at position 1 /);
    assert.throws(() => parse({ text: "[1,]" }), /^Error: INVALID_JSON: at position 3 /);
    assert.throws(() => parse({ text: "1 2" }), /^Error: INVALID_JSON: at position 2 /);
    // Nesting is limited (resource limit shared with the Splice runtime); strings don't count.
    assert.throws(() => parse({ text: "[".repeat(200_000) + "]".repeat(200_000) }), /^Error: INVALID_JSON: nested deeper than 256 levels/);
    assert.throws(() => parse({ text: "[".repeat(200_000) }), /^Error: INVALID_JSON: nested deeper than 256 levels/);
    assert.equal(parse({ text: "[".repeat(256) + "]".repeat(256) }).type, "array");
    assert.deepEqual(parse({ text: JSON.stringify({ s: "[[[[[[[[".repeat(100) }) }).type, "object");
  });

  it("stringifies compactly, indented, and canonically with sortKeys", () => {
    assert.deepEqual(stringify({ value: { b: 1, a: [2, 1] } }), { text: '{"b":1,"a":[2,1]}', bytes: 17 });
    assert.equal(stringify({ value: { a: 1 }, indent: 2 }).text, '{\n  "a": 1\n}');
    assert.equal(stringify({ value: { b: { d: 1, c: 2 }, a: 0 }, sortKeys: true }).text, '{"a":0,"b":{"c":2,"d":1}}');
    assert.equal(stringify({ value: "é" }).bytes, 4, "bytes are UTF-8");
    assert.equal(stringify({ value: JSON.parse('{"__proto__":{"x":1},"a":1}'), sortKeys: true }).text, '{"__proto__":{"x":1},"a":1}');
  });

  it("is deterministic: same input, same output", () => {
    const value = { z: [3, { y: 1, x: 2 }], a: "b", m: { k: null } };
    const shuffled = { m: { k: null }, a: "b", z: [3, { x: 2, y: 1 }] };
    const runs = new Set([value, shuffled, value].map((v) => stringify({ value: v, sortKeys: true }).text));
    assert.equal(runs.size, 1);
  });

  it("picks values by path and reports missing ones", () => {
    const value = { repo: { "full.name": "a/b", owner: { login: "a" }, tags: ["x", "y"] }, n: 0, nil: null };
    assert.deepEqual(pick({ value, paths: ["repo.owner.login", 'repo["full.name"]', "repo.tags[1]", "n", "nil", "$", "repo.tags[5]", "nope.deeper"] }), {
      results: [
        { path: "repo.owner.login", found: true, value: "a" },
        { path: 'repo["full.name"]', found: true, value: "a/b" },
        { path: "repo.tags[1]", found: true, value: "y" },
        { path: "n", found: true, value: 0 },
        { path: "nil", found: true, value: null },
        { path: "$", found: true, value },
        { path: "repo.tags[5]", found: false },
        { path: "nope.deeper", found: false },
      ],
      missing: ["repo.tags[5]", "nope.deeper"],
    });
  });

  it("never reads through the prototype chain", () => {
    assert.deepEqual(pick({ value: {}, paths: ["constructor", "__proto__", "toString"] }).missing, ["constructor", "__proto__", "toString"]);
    assert.deepEqual(pick({ value: [1], paths: ["length"] }).missing, ["length"]);
  });

  it("parses path syntax strictly", () => {
    assert.deepEqual(parsePath("a.b[0]"), ["a", "b", 0]);
    assert.deepEqual(parsePath("$.a"), ["a"]);
    assert.deepEqual(parsePath('$["a.b"][2]'), ["a.b", 2]);
    assert.deepEqual(parsePath("[0].x"), [0, "x"]);
    for (const bad of ["a..b", "a.", ".a", "a[x]", "a[01]", 'a["x]', "a[", "a]b", "a[-1]"]) {
      assert.throws(() => parsePath(bad), /^Error: INVALID_PATH:/, bad);
    }
  });

  it("matches the documented examples", () => {
    for (const file of readdirSync(join(root, "examples"))) {
      const example = JSON.parse(readFileSync(join(root, "examples", file), "utf8"));
      assert.deepEqual(tools[example.tool]!(example.input as never), example.output, file);
    }
  });
});
