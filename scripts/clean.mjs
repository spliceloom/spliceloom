// Removes build output from every workspace. Builds always start clean: TypeScript 7.0.2's
// incremental state (tsbuildinfo) was observed to skip re-checking files whose dependencies changed.
import { rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const roots = ["packages", "apps"];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    rmSync(join(dir, "dist-worker"), { recursive: true, force: true });
    rmSync(join(dir, "tsconfig.tsbuildinfo"), { force: true });
  }
}
console.log("cleaned");
