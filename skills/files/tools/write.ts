import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { assertOpenedInside, assertRealPathInside, fail, lstatOrNull, resolveSandboxPath, workspaceRoot, type Context } from "../lib/sandbox.ts";

interface WriteInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  mode?: "create" | "overwrite" | "append";
  createDirs?: boolean;
}

interface WriteOutput {
  path: string;
  bytes: number;
  size: number;
  created: boolean;
}

export const MAX_WRITE_BYTES = 1024 * 1024;

export default async function write(input: WriteInput, ctx: Context): Promise<WriteOutput> {
  const root = await workspaceRoot(ctx);
  const { abs, display } = resolveSandboxPath(root, input.path);
  const encoding = input.encoding ?? "utf8";
  if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw fail("INVALID_CONTENT", "content is not valid base64");
  const data = Buffer.from(input.content, encoding);
  if (data.byteLength > MAX_WRITE_BYTES) throw fail("CONTENT_TOO_LARGE", `content is ${data.byteLength} bytes (limit ${MAX_WRITE_BYTES})`);

  const mode = input.mode ?? "create";
  await assertRealPathInside(root, abs);
  const existing = await lstatOrNull(abs);
  if (existing?.isSymbolicLink()) throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" is a symbolic link or junction; links are not followed`);
  if (existing && !existing.isFile()) throw fail("NOT_A_FILE", `"${display}" exists and is not a regular file`);
  if (existing && mode === "create") throw fail("ALREADY_EXISTS", `"${display}" already exists (use mode "overwrite" or "append")`);

  const parent = dirname(abs);
  if (!(await lstatOrNull(parent))) {
    if (input.createDirs === false) throw fail("NOT_FOUND", `the parent directory of "${display}" does not exist`);
    await mkdir(parent, { recursive: true });
  }
  await assertRealPathInside(root, parent);

  // Existing files are opened without truncation, verified, and only then modified.
  const handle = await open(abs, existing ? "r+" : "wx");
  try {
    await assertOpenedInside(root, abs, handle, display);
    if (mode === "append") {
      await handle.write(data, 0, data.byteLength, (await handle.stat()).size);
    } else {
      await handle.truncate(0);
      await handle.write(data, 0, data.byteLength, 0);
    }
    const size = (await handle.stat()).size;
    return { path: display, bytes: data.byteLength, size, created: !existing };
  } finally {
    await handle.close();
  }
}
