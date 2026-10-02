import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

/** Global markets — host capability global.overview. */
export default async function markets(input: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "global.overview", { ...defined(input, []) });
}
