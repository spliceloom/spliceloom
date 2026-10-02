/**
 * Provider data for the website, read from the data layer's own provider registry
 * (@spliceloom/data): names, kinds and declared capabilities are the code's, not copy.
 *
 * Only providers whose integration was verified with live requests are listed (see
 * docs/data-providers.md and scripts/live/*.live.test.ts). Registered but unverified providers
 * — the Robinhood public RPC (not reachable from the verification network), the Robinhood stock
 * API and The Graph (key accepted, no subgraph query run) — are left out rather than claimed.
 */
import { SpliceData } from "../../../packages/data/dist/index.js";

export interface ProviderView {
  id: string;
  name: string;
  domain: "Onchain" | "Market" | "Security" | "Wallet" | "AI" | "Developer" | "Web" | "Stocks" | "Perps" | "DeFi" | "Macro";
  auth: string;
  capabilities: string[];
}

/** Verified providers (live integration tests) → display name and domain. */
const VERIFIED: Record<string, { name: string; domain: ProviderView["domain"] }> = {
  alchemy: { name: "Alchemy", domain: "Onchain" },
  quicknode: { name: "QuickNode", domain: "Onchain" },
  "goldsky-edge": { name: "Goldsky", domain: "Onchain" },
  blockscout: { name: "Blockscout", domain: "Onchain" },
  coingecko: { name: "CoinGecko", domain: "Market" },
  dexscreener: { name: "DexScreener", domain: "Market" },
  geckoterminal: { name: "GeckoTerminal", domain: "Market" },
  goplus: { name: "GoPlus", domain: "Security" },
  zerion: { name: "Zerion", domain: "Wallet" },
  openrouter: { name: "OpenRouter", domain: "AI" },
  gemini: { name: "Gemini", domain: "AI" },
  github: { name: "GitHub", domain: "Developer" },
  tavily: { name: "Tavily", domain: "Web" },
  exa: { name: "Exa", domain: "Web" },
  firecrawl: { name: "Firecrawl", domain: "Web" },
  codex: { name: "Codex", domain: "Market" },
  defillama: { name: "DefiLlama", domain: "DeFi" },
  lighter: { name: "Lighter", domain: "Perps" },
  finnhub: { name: "Finnhub", domain: "Stocks" },
  fred: { name: "FRED", domain: "Macro" },
  "chainlink-candlestick": { name: "Chainlink", domain: "Stocks" },
  "alternative-me": { name: "alternative.me", domain: "Market" },
};

export const PROVIDER_DOMAINS: ProviderView["domain"][] = ["Onchain", "Market", "Security", "Wallet", "Stocks", "Perps", "DeFi", "Macro", "AI", "Web", "Developer"];

export function loadProviders(): ProviderView[] {
  // No keys and no network: only the static descriptors of the registered providers are read.
  const data = new SpliceData({ env: {}, envFile: null, fetch: async () => new Response(null, { status: 599 }) });
  const registered = data.registry.all();
  const views: ProviderView[] = [];
  for (const [id, meta] of Object.entries(VERIFIED)) {
    const p = registered.find((r) => r.name === id);
    if (!p) throw new Error(`site: provider "${id}" is listed as verified but is not registered in @spliceloom/data`);
    const capabilities = [...new Set([...p.capabilities, ...(id === "github" ? (registered.find((r) => r.name === "github-raw")?.capabilities ?? []) : [])])];
    // GitHub and CoinGecko also answer without a key (anonymous API / keyless prices); GoPlus is anonymous by default.
    const auth = p.auth.startsWith("none") ? "no key" : id === "github" || id === "goplus" || p.auth.startsWith("keyless") ? "key optional" : id === "chainlink-candlestick" ? "username + key" : "API key";
    views.push({ id, name: meta.name, domain: meta.domain, auth, capabilities });
  }
  return views;
}
