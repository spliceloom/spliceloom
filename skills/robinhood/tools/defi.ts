import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Robinhood Chain DeFi from DefiLlama — host capability defi.overview. */
export default async function defi(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "defi.overview", { ...defined(input, []) });
}
