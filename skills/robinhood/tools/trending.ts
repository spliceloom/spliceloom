import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Trending tokens on Robinhood Chain — host capability tokens.rank. */
export default async function trending(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "tokens.rank", { ...defined(input, ["window","minLiquidity","limit"]), ...{"kind":"trending"} });
}
