import { capability, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Native ETH balance of an address on Robinhood Chain, pinned to the block it was read at. */
export default async function balance(input: { address: string }, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "onchain.balance", { address: input.address });
}
