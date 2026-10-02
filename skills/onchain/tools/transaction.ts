import { capability, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** A transaction and its receipt (status success / reverted / pending) on Robinhood Chain. */
export default async function transaction(input: { hash: string }, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "onchain.transaction", { hash: input.hash });
}
