/**
 * Calls a Splice host capability. The host (not this package) holds the provider keys and runs the
 * request; the tool receives the data layer's result: { status: "LIVE" | "CACHED", data,
 * provenance } or { status: "UNAVAILABLE" | "ERROR", code, ... }. Nothing is fetched here.
 */
export interface CapabilityContext {
  capability?: (name: string, args?: unknown) => Promise<unknown>;
}

export interface CapabilityResult {
  status: "LIVE" | "CACHED" | "UNAVAILABLE" | "ERROR";
  [key: string]: unknown;
}

export async function capability(ctx: CapabilityContext | undefined, name: string, args: Record<string, unknown>): Promise<CapabilityResult> {
  if (typeof ctx?.capability !== "function") {
    throw new Error("This Splice runtime does not provide host capabilities (ctx.capability); update the Splice CLI/SDK");
  }
  return (await ctx.capability(name, args)) as CapabilityResult;
}

/** Copies only the defined keys (tool input → capability arguments). */
export function defined(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
}
