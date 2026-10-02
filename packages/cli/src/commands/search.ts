import { UsageError, type Context } from "../io.js";
import { printJson, spliceFor } from "./shared.js";

export async function searchCommand(ctx: Context, positionals: string[], limitRaw?: string): Promise<number> {
  const query = positionals.join(" ").trim();
  if (!query) throw new UsageError("search requires a query", "Example: splice search github");
  const limit = limitRaw === undefined ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be an integer between 1 and 100");

  // The raw response (including the registry's normalized query) keeps `--json` output unchanged.
  const response = await (await spliceFor(ctx).registry()).search(query, limit);
  if (ctx.json) {
    printJson(ctx, response);
    return 0;
  }
  if (response.results.length === 0) {
    ctx.out(`No packages found for "${query}".`);
    return 0;
  }
  response.results.forEach((result, i) => {
    if (i > 0) ctx.out();
    ctx.out(ctx.style.bold(result.name));
    ctx.out(result.description);
    ctx.out(ctx.style.dim(`latest: ${result.latest}`));
  });
  return 0;
}
