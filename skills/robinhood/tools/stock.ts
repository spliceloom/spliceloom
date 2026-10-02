import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** A Robinhood Stock Token — host capability stock.quote. */
export default async function stock(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "stock.quote", { ...defined(input, ["symbol","session"]) });
}
