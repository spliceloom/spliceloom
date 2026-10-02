import { capability, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

interface PairsInput {
  network: string;
  token: string;
}

/** DEX pairs/pools of a token with price, liquidity, volume, transactions, FDV and market cap per pair. */
export default async function pairs(input: PairsInput, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "market.pairs", { network: input.network, address: input.token });
}
