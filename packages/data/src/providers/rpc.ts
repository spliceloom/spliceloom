/**
 * JSON-RPC providers for Robinhood Chain: Alchemy, QuickNode, Goldsky Edge RPC and the public
 * Robinhood RPC. Standard Ethereum JSON-RPC methods; Alchemy additionally exposes its token
 * APIs (alchemy_getTokenBalances / getTokenMetadata / getAssetTransfers) on Robinhood Mainnet,
 * QuickNode exposes debug_traceTransaction. Capabilities were verified with live requests; the
 * chain id is verified (eth_chainId) before a provider is used for a chain.
 */
import type { ChainInfo } from "../chains.js";
import type { HttpClient } from "../http.js";
import type { Provider, ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";
import { hexToDecimal } from "../units.js";

export const RPC_CORE: ProviderCapability[] = [
  "chain.id",
  "block.latest",
  "block.get",
  "tx.get",
  "tx.receipt",
  "account.balance",
  "account.nonce",
  "contract.code",
  "contract.call",
  "contract.storage",
  "logs.query",
  "gas.price",
];

export interface RpcProviderConfig {
  name: string;
  /** Endpoint per chain key (null = not configured). */
  urls: Record<string, string | null>;
  capabilities: ProviderCapability[];
  auth: string;
  envVars: string[];
  endpoint: string;
  rateLimit: string;
  docs: string;
  verification: string;
  unconfigured: string | null;
}

const UNSUPPORTED = /not available|does not exist|unsupported method|method not found|not supported|not enabled|is not available on/i;

export class RpcProvider implements Provider {
  readonly kind: ProviderKind = "rpc";
  readonly name: string;
  readonly chains: string[];
  readonly capabilities: ProviderCapability[];
  readonly auth: string;
  readonly envVars: string[];
  readonly endpoint: string;
  readonly rateLimit: string;
  readonly docs: string;
  readonly verification: string;
  readonly unconfigured: string | null;
  private id = 0;

  constructor(
    private readonly config: RpcProviderConfig,
    private readonly http: HttpClient,
  ) {
    this.name = config.name;
    this.chains = Object.entries(config.urls).filter(([, u]) => u !== null).map(([k]) => k);
    if (this.chains.length === 0) this.chains = Object.keys(config.urls);
    this.capabilities = config.capabilities;
    this.auth = config.auth;
    this.envVars = config.envVars;
    this.endpoint = config.endpoint;
    this.rateLimit = config.rateLimit;
    this.docs = config.docs;
    this.verification = config.verification;
    this.unconfigured = config.unconfigured;
  }

  /** Raw JSON-RPC call. Errors become ProviderError with a kind the router understands. */
  async call<T = unknown>(chain: ChainInfo, method: string, params: unknown[] = []): Promise<{ result: T; ms: number }> {
    const url = this.config.urls[chain.key];
    if (!url) throw new ProviderError(`${this.name} has no endpoint for ${chain.key}`, "unsupported");
    const response = await this.http.json<{ result?: T; error?: { code: number; message: string } }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    const body = response.body;
    if (body?.error) {
      const message = this.http.redact(`${method}: ${body.error.message} (code ${body.error.code})`);
      if (UNSUPPORTED.test(body.error.message)) throw new ProviderError(message, "unsupported");
      if (body.error.code === 429 || /rate limit|too many requests|exceeded/i.test(body.error.message)) throw new ProviderError(message, "rate_limited");
      if (/invalid params|invalid argument|expected a valid/i.test(body.error.message) || body.error.code === -32602) throw new ProviderError(message, "not_found");
      throw new ProviderError(message, "http");
    }
    if (!body || !("result" in body)) throw new ProviderError(`${method}: malformed JSON-RPC response`, "invalid_response");
    return { result: body.result as T, ms: response.ms };
  }

  async chainId(chain: ChainInfo): Promise<number> {
    const { result } = await this.call<string>(chain, "eth_chainId");
    return Number(hexToDecimal(result));
  }

  async check(chain: ChainInfo): Promise<{ detail: string; chainId: number; blockNumber: string }> {
    const chainId = await this.chainId(chain);
    const { result } = await this.call<string>(chain, "eth_blockNumber");
    return { detail: `eth_chainId=${chainId}, eth_blockNumber=${hexToDecimal(result)}`, chainId, blockNumber: hexToDecimal(result) };
  }
}

/** Official public Robinhood Chain mainnet RPC (docs.robinhood.com/chain/connecting). */
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/** Robinhood RPC providers configured from the environment. */
export function rpcProviders(env: Record<string, string | undefined>, http: (hosts: string[]) => HttpClient): RpcProvider[] {
  const alchemyUrl = env.ALCHEMY_RPC_URL ?? (env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : null);
  const goldskyMain = env.GOLDSKY_API_KEY ? `https://edge.goldsky.com/standard/evm/4663?key=${env.GOLDSKY_API_KEY}` : null;
  // The official public RPC needs no key, so on-chain data works out of the box; `off` disables it.
  const publicRpc = env.ROBINHOOD_PUBLIC_RPC_URL === "off" ? null : (env.ROBINHOOD_PUBLIC_RPC_URL ?? PUBLIC_RPC_URL);
  const hosts = (...urls: Array<string | null | undefined>) => urls.filter((u): u is string => !!u).map((u) => new URL(u).hostname.toLowerCase());
  return [
    new RpcProvider(
      {
        name: "alchemy",
        urls: { robinhood: alchemyUrl },
        capabilities: [...RPC_CORE, "token.balances", "token.metadata", "token.transfers"],
        auth: "API key in the URL path (ALCHEMY_RPC_URL or ALCHEMY_API_KEY)",
        envVars: ["ALCHEMY_RPC_URL", "ALCHEMY_API_KEY"],
        endpoint: "https://robinhood-mainnet.g.alchemy.com/v2/{key}",
        rateLimit: "Free tier: compute-unit based; debug_/trace_ methods not available on the free tier",
        docs: "https://www.alchemy.com/docs",
        verification: "verified live: eth_chainId=4663, core JSON-RPC, alchemy_getTokenBalances, alchemy_getTokenMetadata, alchemy_getAssetTransfers; debug_traceTransaction and trace_transaction refused (free tier / not on Robinhood)",
        unconfigured: alchemyUrl ? null : "ALCHEMY_RPC_URL or ALCHEMY_API_KEY is not set",
      },
      http(hosts(alchemyUrl)),
    ),
    new RpcProvider(
      {
        name: "quicknode",
        urls: { robinhood: env.QUICKNODE_RPC_URL ?? null },
        capabilities: [...RPC_CORE, "trace.transaction"],
        auth: "Token in the endpoint URL (QUICKNODE_RPC_URL)",
        envVars: ["QUICKNODE_RPC_URL"],
        endpoint: "https://{name}.robinhood-mainnet.quiknode.pro/{token}/",
        rateLimit: "Plan dependent; Token & NFT API add-on not enabled on this endpoint",
        docs: "https://www.quicknode.com/docs",
        verification: "verified live: eth_chainId=4663, core JSON-RPC, debug_traceTransaction (callTracer); qn_getWalletTokenBalance refused (add-on not enabled)",
        unconfigured: env.QUICKNODE_RPC_URL ? null : "QUICKNODE_RPC_URL is not set",
      },
      http(hosts(env.QUICKNODE_RPC_URL)),
    ),
    new RpcProvider(
      {
        name: "goldsky-edge",
        urls: { robinhood: goldskyMain },
        capabilities: [...RPC_CORE],
        auth: "API key as ?key= query parameter (GOLDSKY_API_KEY)",
        envVars: ["GOLDSKY_API_KEY"],
        endpoint: "https://edge.goldsky.com/standard/evm/4663?key={key}",
        rateLimit: "Plan dependent",
        docs: "https://docs.goldsky.com/chains/robinhood-chain",
        verification: "verified live with a gs_edge_ key: eth_chainId=4663, core JSON-RPC. Without a key the endpoint answers HTTP 402 (x402)",
        unconfigured: env.GOLDSKY_API_KEY ? null : "GOLDSKY_API_KEY is not set",
      },
      http(hosts(goldskyMain)),
    ),
    new RpcProvider(
      {
        name: "robinhood-public-rpc",
        urls: { robinhood: publicRpc },
        capabilities: [...RPC_CORE],
        auth: "none (official public endpoint; works without any key)",
        envVars: ["ROBINHOOD_PUBLIC_RPC_URL"],
        endpoint: publicRpc ?? PUBLIC_RPC_URL,
        rateLimit: "Public endpoint; limits not documented (configure Alchemy/QuickNode for heavier use)",
        docs: "https://docs.robinhood.com/chain/connecting",
        verification: "default keyless RPC; its chain id is verified live (eth_chainId = 4663) before first use. Not reachable from the verification network (TLS interception by the ISP); TLS is never disabled",
        unconfigured: publicRpc ? null : "disabled (ROBINHOOD_PUBLIC_RPC_URL=off)",
      },
      http(hosts(publicRpc)),
    ),
  ];
}
