/**
 * Unit tests for @splice/files (path policy and tool behaviour, in-process).
 * Run with: node --test tests/*.test.ts
 * That the Node.js permission model confines the package to workspace/ is covered by the Splice
 * repository's integration tests, which run this package in the sandbox.
 */
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { isSensitiveName, resolveSandboxPath } from "../lib/sandbox.ts";
import list from "../tools/list.ts";
import read from "../tools/read.ts";
import write from "../tools/write.ts";

describe("@splice/files", () => {
  let base: string;
  let project: string;
  let workspace: string;
  let ctx: { paths: { project: string } };

  before(() => {
    base = mkdtempSync(join(tmpdir(), "splice-files-"));
  });
  after(() => rmSync(base, { recursive: true, force: true }));
  beforeEach(() => {
    project = mkdtempSync(join(base, "project-"));
    workspace = join(project, "workspace");
    mkdirSync(join(workspace, "data"), { recursive: true });
    writeFileSync(join(workspace, "data", "report.json"), '{"ok":true}');
    writeFileSync(join(workspace, "notes.txt"), "hello");
    writeFileSync(join(project, ".env"), "SECRET=outside");
    writeFileSync(join(project, "splice.json"), "{}");
    ctx = { paths: { project } };
  });

  const code = (c: string) => (e: unknown) => e instanceof Error && e.message.startsWith(`${c}: `);

  it("reads a sandbox file", async () => {
    const r = await read({ path: "data/report.json" }, ctx);
    assert.equal(r.path, "data/report.json");
    assert.equal(r.content, '{"ok":true}');
    assert.equal(r.size, 11);
    assert.equal(r.encoding, "utf8");
    assert.match(r.modifiedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await read({ path: "./notes.txt", encoding: "base64" }, ctx)).content, "aGVsbG8=");
    await assert.rejects(read({ path: "missing.txt" }, ctx), code("NOT_FOUND"));
    await assert.rejects(read({ path: "data" }, ctx), code("NOT_A_FILE"));
    await assert.rejects(read({ path: "notes.txt", maxBytes: 2 }, ctx), code("FILE_TOO_LARGE"));
  });

  it("writes sandbox files with create / overwrite / append semantics", async () => {
    assert.deepEqual(await write({ path: "out/new.txt", content: "one" }, ctx), { path: "out/new.txt", bytes: 3, size: 3, created: true });
    await assert.rejects(write({ path: "out/new.txt", content: "x" }, ctx), code("ALREADY_EXISTS"));
    assert.equal((await write({ path: "out/new.txt", content: "two", mode: "overwrite" }, ctx)).created, false);
    assert.equal((await write({ path: "out/new.txt", content: "+", mode: "append" }, ctx)).size, 4);
    assert.equal(readFileSync(join(workspace, "out", "new.txt"), "utf8"), "two+");
    await write({ path: "bin.dat", content: "AAEC", encoding: "base64" }, ctx);
    assert.deepEqual([...readFileSync(join(workspace, "bin.dat"))], [0, 1, 2]);
    await assert.rejects(write({ path: "bad.dat", content: "***", encoding: "base64" }, ctx), code("INVALID_CONTENT"));
    await assert.rejects(write({ path: "deep/er/x.txt", content: "x", createDirs: false }, ctx), code("NOT_FOUND"));
    await assert.rejects(write({ path: "data", content: "x", mode: "overwrite" }, ctx), code("NOT_A_FILE"));
  });

  it("lists the sandbox, sorted, optionally recursive, hiding credential-like names", async () => {
    writeFileSync(join(workspace, ".env"), "SECRET=inside");
    writeFileSync(join(workspace, "id_rsa"), "key");
    const top = await list({}, ctx);
    assert.deepEqual(top, {
      path: ".",
      entries: [
        { path: "data", type: "directory", size: 0 },
        { path: "notes.txt", type: "file", size: 5 },
      ],
      truncated: false,
      hidden: 2,
    });
    const all = await list({ recursive: true }, ctx);
    assert.deepEqual(all.entries.map((e) => e.path), ["data", "notes.txt", "data/report.json"]);
    assert.deepEqual((await list({ path: "data" }, ctx)).entries.map((e) => e.path), ["data/report.json"]);
    assert.equal((await list({ recursive: true, maxEntries: 1 }, ctx)).truncated, true);
    await assert.rejects(list({ path: "notes.txt" }, ctx), code("NOT_A_DIRECTORY"));
  });

  it("rejects path traversal", async () => {
    for (const path of ["../splice.json", "data/../../.env", "..", "a/../../b"]) {
      await assert.rejects(read({ path }, ctx), code("PATH_OUTSIDE_SANDBOX"), path);
      await assert.rejects(write({ path, content: "x", mode: "overwrite" }, ctx), code("PATH_OUTSIDE_SANDBOX"), path);
    }
    await assert.rejects(list({ path: ".." }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    assert.equal(readFileSync(join(project, ".env"), "utf8"), "SECRET=outside", "nothing outside the sandbox changed");
  });

  it("rejects absolute paths and malformed paths", async () => {
    for (const path of ["/etc/passwd", "C:/Windows/win.ini", "c:secret", "~/.ssh/id_rsa", join(project, "splice.json").replaceAll("\\", "/")]) {
      await assert.rejects(read({ path }, ctx), code("PATH_OUTSIDE_SANDBOX"), path);
    }
    await assert.rejects(read({ path: "data\\report.json" }, ctx), code("INVALID_PATH"));
    await assert.rejects(read({ path: "a\0b" }, ctx), code("INVALID_PATH"));
    await assert.rejects(read({ path: "a//b" }, ctx), code("INVALID_PATH"));
    await assert.rejects(read({ path: "." }, ctx), code("INVALID_PATH"));
    await assert.rejects(read({ path: "x".repeat(600) }, ctx), code("INVALID_PATH"));
  });

  it("refuses credential and secret files even inside the sandbox", async () => {
    writeFileSync(join(workspace, ".env"), "SECRET=inside");
    for (const path of [".env", ".env.local", "config/.env.production", "keys/server.pem", "tls.key", "id_ed25519", ".ssh/config", ".aws/credentials", ".npmrc", ".netrc", ".git-credentials", "credentials.json", "secrets.yaml"]) {
      await assert.rejects(read({ path }, ctx), code("SENSITIVE_PATH"), path);
      await assert.rejects(write({ path, content: "x", mode: "overwrite" }, ctx), code("SENSITIVE_PATH"), path);
    }
    assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "SECRET=inside");
    for (const ok of ["environment.md", "keyboard.txt", "monkey.json", "public-keys.txt", "credential-guide.md"]) assert.equal(isSensitiveName(ok), false, ok);
  });

  it("does not follow symbolic links out of the sandbox", async (t) => {
    try {
      symlinkSync(project, join(workspace, "escape"), "junction");
    } catch {
      t.skip("symbolic links are not permitted on this system");
      return;
    }
    await assert.rejects(read({ path: "escape/splice.json" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    await assert.rejects(write({ path: "escape/pwned.txt", content: "x" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    await assert.rejects(list({ path: "escape" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    assert.equal((await list({}, ctx)).entries.find((e) => e.path === "escape")?.type, "symlink", "listed, never followed");
  });

  it("refuses Windows-unsafe names on every platform (fail closed)", async () => {
    writeFileSync(join(workspace, ".env"), "SECRET=inside");
    for (const path of [
      ".env.", // Windows strips trailing dots: would open .env
      ".env ", // … and trailing spaces
      "notes.txt:secret", // NTFS alternate data stream
      "notes.txt::$DATA",
      "CON",
      "nul.txt",
      "com1",
      "LPT9.log",
      "conin$",
      "data/aux.json",
      "PROGRA~1/x", // 8.3 short-name alias
      "SECRET~1.YAM",
      "a<b",
      "a|b",
      "tab\tname",
    ]) {
      await assert.rejects(read({ path }, ctx), code("INVALID_PATH"), JSON.stringify(path));
      await assert.rejects(write({ path, content: "x", mode: "overwrite" }, ctx), code("INVALID_PATH"), JSON.stringify(path));
    }
    assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "SECRET=inside");
  });

  it("refuses UNC paths and drive-letter paths", async () => {
    for (const path of ["//server/share/file.txt", "//?/C:/Windows/win.ini", "//./pipe/x", "D:secret.txt", "c:/x"]) {
      await assert.rejects(read({ path }, ctx), code("PATH_OUTSIDE_SANDBOX"), path);
    }
    for (const path of ["\\\\server\\share\\x", "\\\\?\\C:\\x", "data\\..\\..\\x"]) await assert.rejects(read({ path }, ctx), code("INVALID_PATH"), path);
  });

  it("refuses hard links (they can alias files outside the sandbox)", async (t) => {
    const outside = join(project, "outside-secret.txt");
    writeFileSync(outside, "outside data");
    try {
      linkSync(outside, join(workspace, "alias.txt"));
    } catch {
      t.skip("hard links are not supported here");
      return;
    }
    await assert.rejects(read({ path: "alias.txt" }, ctx), code("HARD_LINK"));
    await assert.rejects(write({ path: "alias.txt", content: "pwned", mode: "overwrite" }, ctx), code("HARD_LINK"));
    await assert.rejects(write({ path: "alias.txt", content: "!", mode: "append" }, ctx), code("HARD_LINK"));
    assert.equal(readFileSync(outside, "utf8"), "outside data", "the outside file was not modified");
  });

  it("does not follow file symlinks either (where the OS allows creating them)", async (t) => {
    writeFileSync(join(project, "target.txt"), "outside");
    try {
      symlinkSync(join(project, "target.txt"), join(workspace, "link.txt"), "file");
    } catch {
      t.skip("file symlinks need extra privileges on this system");
      return;
    }
    await assert.rejects(read({ path: "link.txt" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    await assert.rejects(write({ path: "link.txt", content: "x", mode: "overwrite" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    assert.equal(readFileSync(join(project, "target.txt"), "utf8"), "outside");
  });

  it("junctions inside the path are resolved and refused, even for new files", async (t) => {
    mkdirSync(join(project, "elsewhere"));
    try {
      symlinkSync(join(project, "elsewhere"), join(workspace, "j"), "junction");
    } catch {
      t.skip("junctions/directory links are not permitted on this system");
      return;
    }
    await assert.rejects(write({ path: "j/new.txt", content: "x" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    await assert.rejects(write({ path: "j/sub/new.txt", content: "x" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    await assert.rejects(list({ path: "j" }, ctx), code("PATH_OUTSIDE_SANDBOX"));
    assert.deepEqual(readdirSync(join(project, "elsewhere")), [], "nothing was created through the junction");
  });

  it("resolves paths deterministically", () => {
    const root = join(base, "root");
    assert.deepEqual(resolveSandboxPath(root, "a/b.txt").segments, ["a", "b.txt"]);
    assert.equal(resolveSandboxPath(root, "./a/").display, "a");
    assert.equal(resolveSandboxPath(root, ".", true).display, ".");
  });
});
