import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Funding rates — host capability perps.funding. */
export default async function funding(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "perps.funding", { ...defined(input, ["venue","search","limit"]) });
}
