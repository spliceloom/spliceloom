import { open } from "node:fs/promises";
import { assertOpenedInside, assertRealPathInside, fail, lstatOrNull, resolveSandboxPath, workspaceRoot, type Context } from "../lib/sandbox.ts";

interface ReadInput {
  path: string;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
}

interface ReadOutput {
  path: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
  modifiedAt: string;
}

export const DEFAULT_MAX_BYTES = 256 * 1024;

export default async function read(input: ReadInput, ctx: Context): Promise<ReadOutput> {
  const root = await workspaceRoot(ctx);
  const { abs, display } = resolveSandboxPath(root, input.path);
  const stat = await lstatOrNull(abs);
  if (!stat) throw fail("NOT_FOUND", `"${display}" does not exist in the sandbox`);
  if (stat.isSymbolicLink()) throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" is a symbolic link or junction; links are not followed`);
  await assertRealPathInside(root, abs);
  if (!stat.isFile()) throw fail("NOT_A_FILE", `"${display}" is not a regular file`);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (stat.size > maxBytes) throw fail("FILE_TOO_LARGE", `"${display}" is ${stat.size} bytes (limit ${maxBytes}; raise maxBytes up to 524288)`);

  const handle = await open(abs, "r");
  try {
    await assertOpenedInside(root, abs, handle, display);
    // Read at most maxBytes + 1 so a file that grew since the check is still bounded and refused.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) throw fail("FILE_TOO_LARGE", `"${display}" is larger than ${maxBytes} bytes`);
    }
    const bytes = buffer.subarray(0, length);
    const encoding = input.encoding ?? "utf8";
    return {
      path: display,
      size: length,
      encoding,
      content: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"),
      modifiedAt: stat.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}
