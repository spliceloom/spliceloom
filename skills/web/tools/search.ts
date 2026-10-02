import { capability, defined, type CapabilityContext, type CapabilityResult } from "../lib/broker.ts";

interface SearchInput {
  query: string;
  limit?: number;
  content?: boolean;
  maxCharacters?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

/** Web search through the host (Tavily → Exa → Firecrawl). Returns the host's result unchanged. */
export default async function search(input: SearchInput, ctx: CapabilityContext): Promise<CapabilityResult> {
  return capability(ctx, "web.search", defined(input as unknown as Record<string, unknown>, ["query", "limit", "content", "maxCharacters", "includeDomains", "excludeDomains"]));
}
