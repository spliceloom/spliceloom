import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Research and risk report — host capability tokens.report. */
export default async function report(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "tokens.report", { ...defined(input, ["token"]) });
}
