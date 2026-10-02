import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Large trades of a token in its latest ~100 swaps — host capability tokens.whales. */
export default async function whales(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "tokens.whales", { ...defined(input, ["token","minUsd"]) });
}
