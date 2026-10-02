import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Rank every Robinhood Chain token — host capability tokens.rank. */
export default async function rank(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "tokens.rank", { ...defined(input, ["kind","window","minLiquidity","limit"]) });
}
