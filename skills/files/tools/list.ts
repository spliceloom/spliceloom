import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertRealPathInside, fail, isSensitiveName, lstatOrNull, resolveSandboxPath, workspaceRoot, type Context } from "../lib/sandbox.ts";

interface ListInput {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
}

interface Entry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

interface ListOutput {
  path: string;
  entries: Entry[];
  truncated: boolean;
  hidden: number;
}

export const DEFAULT_MAX_ENTRIES = 500;
const MAX_DEPTH = 16;

export default async function list(input: ListInput, ctx: Context): Promise<ListOutput> {
  const root = await workspaceRoot(ctx);
  const { abs, display, segments } = resolveSandboxPath(root, input.path ?? ".", true);
  const stat = await lstatOrNull(abs);
  if (!stat) throw fail("NOT_FOUND", `"${display}" does not exist in the sandbox`);
  if (stat.isSymbolicLink()) throw fail("PATH_OUTSIDE_SANDBOX", `"${display}" is a symbolic link; links are not followed`);
  await assertRealPathInside(root, abs);
  if (!stat.isDirectory()) throw fail("NOT_A_DIRECTORY", `"${display}" is not a directory`);

  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries: Entry[] = [];
  let hidden = 0;
  let truncated = false;
  // Breadth-first, sorted, never following symlinks.
  const queue: Array<{ dir: string; rel: string[]; depth: number }> = [{ dir: abs, rel: segments, depth: 0 }];
  while (queue.length > 0 && !truncated) {
    const { dir, rel, depth } = queue.shift()!;
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (isSensitiveName(item.name)) {
        hidden++;
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const path = [...rel, item.name].join("/");
      const full = join(dir, item.name);
      const type: Entry["type"] = item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
      const size = type === "file" ? ((await lstatOrNull(full))?.size ?? 0) : 0;
      entries.push({ path, type, size });
      if (type === "directory" && input.recursive && depth < MAX_DEPTH) queue.push({ dir: full, rel: [...rel, item.name], depth: depth + 1 });
    }
  }
  return { path: display, entries, truncated, hidden };
}
