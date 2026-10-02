import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

interface CandlesInput {
  network: string;
  pool: string;
  timeframe?: "day" | "hour" | "minute";
  aggregate?: number;
  limit?: number;
}

/** OHLCV candles of a DEX pool (GeckoTerminal on the host). */
export default async function candles(input: CandlesInput, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "market.ohlcv", defined(input as unknown as Record<string, unknown>, ["network", "pool", "timeframe", "aggregate", "limit"]));
}
