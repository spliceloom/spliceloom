/**
 * Every data-layer response states what it is:
 *
 * - LIVE         fetched from a real provider for this request (fresh: true)
 * - CACHED       a previously fetched real response, with its original provenance and age (fresh: false)
 * - UNAVAILABLE  no configured, healthy provider offers this capability on this chain (CAPABILITY_UNAVAILABLE)
 * - ERROR        providers were asked and failed, or the input/object is invalid/not found
 *
 * There is no other kind of value: nothing is estimated, defaulted or invented.
 */

export interface Provenance {
  /** Provider that produced the data (e.g. "alchemy", "blockscout", "coingecko", "github"). */
  source: string;
  /** Scope of the request: a Splice chain key, a provider network id (market data) or "global". */
  chain: string;
  /** EVM chain id when the scope is a known chain; null for networks Splice does not model and "global". */
  chainId: number | null;
  /** The provider resource the data came from (e.g. "repos/nodejs/node", "token-pairs/robinhood/0x…"). */
  resource?: string;
  /** When the provider response was received (ISO 8601). */
  fetchedAt: string;
  /** True only when fetched from the provider for this request. */
  fresh: boolean;
  /** Block the data refers to, when the provider reports one (decimal string). */
  blockNumber?: string;
  blockHash?: string;
  /** Provider request/correlation id when the provider returns one. */
  requestId?: string;
  /** Providers tried before this one, with their errors (fallback trail). */
  fallbackFrom?: Array<{ provider: string; error: string }>;
  /** When this response stops being served from the cache (set when it is cacheable). */
  expiresAt?: string;
  /** Present for CACHED results: request identity, age and expiry of the cached real response. */
  cache?: { key: string; cachedAt: string; ageMs: number; ttlMs: number; expiresAt: string };
  /** Provider rate-limit state from its response headers, when it reports one. */
  rateLimit?: { limit?: number; remaining?: number; resetAt?: string; resource?: string };
  /** Free-form provider-specific facts (e.g. "unnormalized provider payload"). */
  notes?: string[];
}

export interface LiveResult<T> {
  status: "LIVE" | "CACHED";
  capability: string;
  data: T;
  provenance: Provenance;
}

export interface UnavailableResult {
  status: "UNAVAILABLE";
  code: "CAPABILITY_UNAVAILABLE";
  capability: string;
  chain: string;
  chainId: number | null;
  /** Provider asked about, or null when none declares the capability. */
  provider: string | null;
  reason: string;
  /** Providers that declare the capability but cannot be used right now, and why. */
  providers?: Array<{ provider: string; reason: string }>;
  timestamp: string;
}

export type ErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "PROVIDER_ERROR" | "RATE_LIMITED" | "ALL_PROVIDERS_FAILED" | "CHAIN_MISMATCH";

/** The scope a result refers to (a ChainInfo satisfies it). */
export interface ResultScope {
  key: string;
  chainId: number | null;
}

export interface ErrorResult {
  status: "ERROR";
  code: ErrorCode;
  capability: string;
  chain: string;
  chainId: number | null;
  message: string;
  attempts: Array<{ provider: string; error: string; status?: number }>;
  timestamp: string;
}

export type DataResult<T> = LiveResult<T> | UnavailableResult | ErrorResult;

export const isLive = <T>(r: DataResult<T>): r is LiveResult<T> => r.status === "LIVE" || r.status === "CACHED";

export function unavailable(capability: string, chain: ResultScope | null, reason: string, extra: { provider?: string | null; providers?: Array<{ provider: string; reason: string }> } = {}): UnavailableResult {
  const result: UnavailableResult = {
    status: "UNAVAILABLE",
    code: "CAPABILITY_UNAVAILABLE",
    capability,
    chain: chain?.key ?? "unknown",
    chainId: chain?.chainId ?? null,
    provider: extra.provider ?? null,
    reason,
    timestamp: new Date().toISOString(),
  };
  if (extra.providers?.length) result.providers = extra.providers;
  return result;
}

export function failure(code: ErrorCode, capability: string, chain: ResultScope | null, message: string, attempts: ErrorResult["attempts"] = []): ErrorResult {
  return { status: "ERROR", code, capability, chain: chain?.key ?? "unknown", chainId: chain?.chainId ?? null, message, attempts, timestamp: new Date().toISOString() };
}

/** Error thrown inside provider operations; the router turns it into a structured result. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /**
     * `not_listed`: the provider answered and has no data for this object (e.g. token without a market listing).
     * `unsupported`: the provider cannot serve this capability in this scope (plan, network, auth requirement).
     * `rejected`: the provider refused this specific request (e.g. GitHub 409 empty repository, 422 invalid
     * query) — another provider would refuse it too, so it is returned as an error without fallback.
     */
    readonly kind: "network" | "http" | "auth" | "rate_limited" | "not_found" | "not_listed" | "unsupported" | "rejected" | "invalid_response" | "chain_mismatch",
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
