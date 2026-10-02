/**
 * Chains the data layer knows. Robinhood Chain is first-class; mainnet is the default.
 * Every RPC provider's chain id is verified live (eth_chainId) before it is used for a chain.
 */

export interface ChainInfo {
  /** Splice chain key used in APIs and the CLI (`--chain`). */
  key: string;
  name: string;
  chainId: number;
  network: "mainnet";
  nativeCurrency: { symbol: string; decimals: number };
  /** Identifiers of this chain in third-party provider APIs (verified live where noted in docs). */
  ids: {
    coingeckoPlatform?: string;
    coingeckoNativeCoin?: string;
    coingeckoOnchainNetwork?: string;
    goplusChainId?: string;
    zerionChainId?: string;
    blockscoutChainId?: string;
    /** DexScreener chainId (verified live: /token-pairs/v1/robinhood/… returns Robinhood pairs). */
    dexscreenerChainId?: string;
    /** GeckoTerminal network id (verified live: /networks/robinhood/tokens/…/pools). */
    geckoterminalNetwork?: string;
    /** DefiLlama chain name (verified live: /v2/chains lists "Robinhood Chain", chainId 4663). */
    defillamaChain?: string;
    /** DefiLlama coins API chain prefix (verified live: coins.llama.fi/prices/current/robinhood:0x…). */
    defillamaCoinsChain?: string;
    /** Codex network id (verified live: getNetworks lists 4663 "Robinhood"). */
    codexNetworkId?: number;
  };
}

/**
 * What a provider request is scoped to. Chain-bound capabilities use a ChainInfo; market data uses
 * a network scope (a Splice chain, or a provider-native network id such as "solana"); AI and
 * developer data use the global scope.
 */
export interface Scope {
  key: string;
  name: string;
  /** EVM chain id when the scope is a Splice chain, otherwise null. */
  chainId: number | null;
  /** Set when the scope is a Splice chain: its provider identifiers. */
  chain?: ChainInfo;
}

export const GLOBAL_SCOPE: Scope = { key: "global", name: "global", chainId: null };

export const chainScope = (chain: ChainInfo): Scope => ({ key: chain.key, name: chain.name, chainId: chain.chainId, chain });

/**
 * Market network scope: a Splice chain key/id ("robinhood", "4663") maps to that chain — providers
 * then use their own identifier for it only where it is verified (ChainInfo.ids). Anything else
 * is taken as a provider-native network id ("solana", "base", "eth"…) and passed through as is;
 * each provider decides whether it knows that network. Nothing is ever mapped to another chain.
 */
export function resolveMarketScope(input: string | number | undefined): Scope | null {
  const chain = resolveChain(input);
  if (chain) return chainScope(chain);
  const value = String(input ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) return null;
  return { key: value, name: value, chainId: null };
}

export const CHAINS: readonly ChainInfo[] = [
  {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    network: "mainnet",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    ids: {
      coingeckoPlatform: "robinhood",
      coingeckoNativeCoin: "ethereum",
      coingeckoOnchainNetwork: "robinhood",
      goplusChainId: "4663",
      zerionChainId: "robinhood",
      blockscoutChainId: "4663",
      dexscreenerChainId: "robinhood",
      geckoterminalNetwork: "robinhood",
      defillamaChain: "Robinhood Chain",
      defillamaCoinsChain: "robinhood",
      codexNetworkId: 4663,
    },
  },
];


export const DEFAULT_CHAIN = "robinhood";

/** Resolves `robinhood`, `4663`, `mainnet` and `robinhood-mainnet`. Only Robinhood Chain mainnet is supported. */
export function resolveChain(input: string | number | undefined): ChainInfo | null {
  if (input === undefined || input === "") return CHAINS.find((c) => c.key === DEFAULT_CHAIN)!;
  const value = String(input).trim().toLowerCase();
  if (value === "mainnet" || value === "robinhood-mainnet") return CHAINS[0]!;
  return CHAINS.find((c) => c.key === value || String(c.chainId) === value) ?? null;
}
