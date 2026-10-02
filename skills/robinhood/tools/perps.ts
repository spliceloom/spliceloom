import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Perpetual — host capability perps.markets. */
export default async function perps(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "perps.markets", { ...defined(input, ["venue","type","sort","search","limit"]) });
}
