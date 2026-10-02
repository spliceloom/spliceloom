import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

interface PriceInput {
  token: string;
  network?: string;
  vs?: string;
}

/** Token price: ETH or a token on Robinhood Chain (CoinGecko → GeckoTerminal), or a token on another DEX network. */
export default async function price(input: PriceInput, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "market.price", defined(input as unknown as Record<string, unknown>, ["token", "network", "vs"]));
}
