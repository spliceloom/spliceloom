import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** One token by symbol or address — host capability tokens.details. */
export default async function token(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "tokens.details", { ...defined(input, ["token"]) });
}
