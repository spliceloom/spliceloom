import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

interface ReadInput {
  urls: string[];
  maxCharacters?: number;
}

/** Readable text of public web pages through the host (Tavily → Firecrawl → Exa). */
export default async function read(input: ReadInput, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "web.extract", defined(input as unknown as Record<string, unknown>, ["urls", "maxCharacters"]));
}
