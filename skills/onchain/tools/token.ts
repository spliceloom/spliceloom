import { capability, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/**
 * A token on Robinhood Chain: metadata, total supply, holders, price, DEX pools and security report.
 * The host answers with one section per source (each with its own status and provenance).
 */
export default async function token(input: { address: string }, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "onchain.token", { address: input.address });
}
