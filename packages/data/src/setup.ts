/**
 * Onboarding guide: which features work without any key, and which provider variables unlock
 * more (with the page where each key is created). Used by `splice setup`; never contains or
 * prints key values — only variable names and whether they are set.
 */
import type { ProviderEnv } from "./env.js";

export interface SetupKey {
  provider: string;
  /** Variables: alternatives (one is enough), or all required together when `together` is set. */
  env: string[];
  together?: boolean;
  /** Where the key is created. */
  url: string;
  note?: string;
}

export interface SetupFeature {
  feature: string;
  commands: string[];
  /** What works with no key at all (null: nothing without a key). */
  withoutKeys: string | null;
  keys: SetupKey[];
}

export const SETUP_GUIDE: SetupFeature[] = [
  {
    feature: "Robinhood Chain on-chain data",
    commands: ["splice chain info", "splice block latest", "splice wallet balances <address>", "splice tx inspect <hash>"],
    withoutKeys: "blocks, transactions, balances, code, logs through the official public RPC (rpc.mainnet.chain.robinhood.com)",
    keys: [
      { provider: "Alchemy", env: ["ALCHEMY_API_KEY", "ALCHEMY_RPC_URL"], url: "https://dashboard.alchemy.com", note: "faster RPC + token balances/metadata/transfers (free tier)" },
      { provider: "QuickNode", env: ["QUICKNODE_RPC_URL"], url: "https://dashboard.quicknode.com", note: "RPC fallback + call traces (free tier)" },
      { provider: "Blockscout PRO", env: ["BLOCKSCOUT_API_KEY"], url: "https://dev.blockscout.com", note: "indexed transactions, holders, verified contracts" },
    ],
  },
  {
    feature: "Market data (prices, trending, gainers/losers, DEX pairs, candles)",
    commands: ["splice price ETH", "splice market gainers", "splice market trending", "splice market pairs robinhood <token>"],
    withoutKeys: "DexScreener and GeckoTerminal (trending/new/top pools, movers, pairs, OHLCV, trades; GeckoTerminal allows 10 calls/min) and CoinGecko prices (keyless public API)",
    keys: [{ provider: "CoinGecko", env: ["COINGECKO_API_KEY"], url: "https://www.coingecko.com/en/developers/dashboard", note: "higher limits + Robinhood DEX pools and movers via the onchain API (free demo key)" }],
  },
  {
    feature: "Every token on Robinhood Chain (trending, hot, new, gainers, holders, trades, charts)",
    commands: ["splice tokens trending", "splice tokens new", "splice tokens info <SYMBOL>", "splice dash"],
    withoutKeys: null,
    keys: [{ provider: "Codex", env: ["CODEX_API_KEY"], url: "https://dashboard.codex.io/signup", note: "free plan: 10,000 requests/month (one-time $1 activation)" }],
  },
  {
    feature: "Global markets (crypto market cap, Fear & Greed, top coins, US stocks/ETFs)",
    commands: ["splice global", "splice global coins", "splice global stocks"],
    withoutKeys: "CoinGecko global data and alternative.me Fear & Greed; US stocks need the Chainlink Candlestick keys",
    keys: [],
  },
  {
    feature: "Perpetuals on Robinhood (Lighter: crypto, US stocks, gold, funding)",
    commands: ["splice perps", "splice perps funding", "splice perps BTC"],
    withoutKeys: "everything: Lighter public market data",
    keys: [],
  },
  {
    feature: "US companies, market news, earnings, market status",
    commands: ["splice stock profile NVDA", "splice news crypto", "splice stock earnings", "splice stock market"],
    withoutKeys: null,
    keys: [{ provider: "Finnhub", env: ["FINNHUB_API_KEY"], url: "https://finnhub.io/register", note: "free: 60 calls/min, personal use" }],
  },
  {
    feature: "US macro (Fed funds, CPI, yields, unemployment, VIX)",
    commands: ["splice macro", "splice macro DGS10"],
    withoutKeys: null,
    keys: [{ provider: "FRED", env: ["FRED_API_KEY"], url: "https://fredaccount.stlouisfed.org/apikeys", note: "free" }],
  },
  {
    feature: "Alerts to Discord and Telegram (splice watch / splice radar --notify)",
    commands: ["splice radar --notify discord", "splice watch <token> --above <price> --notify telegram", "splice watch whales <token> --notify discord,telegram"],
    withoutKeys: null,
    keys: [
      { provider: "Discord", env: ["DISCORD_WEBHOOK_URL"], url: "https://support.discord.com/hc/en-us/articles/228383668", note: "channel settings → Integrations → Webhooks → copy the webhook URL" },
      { provider: "Telegram", env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], together: true, url: "https://core.telegram.org/bots/tutorial", note: "create a bot with @BotFather, send it a message, use your chat id" },
    ],
  },
  {
    feature: "Robinhood Stock Tokens (TSLA, NVDA, SPY…)",
    commands: ["splice stock list", "splice stock quote NVDA", "splice stock gainers"],
    withoutKeys: "the official Robinhood Stock Token API (public; blocked by some ISP DNS filters) and the tokens' DEX markets; the CoinGecko list is the fallback",
    keys: [{ provider: "CoinGecko", env: ["COINGECKO_API_KEY"], url: "https://www.coingecko.com/en/developers/dashboard", note: "stock-token movers via the onchain API" }],
  },
  {
    feature: "Oracle prices (Chainlink Data Streams: crypto, US equities)",
    commands: ["splice oracle price ETH", "splice oracle candles TSLA", "splice oracle feeds TSLA"],
    withoutKeys: "the public feed catalog",
    keys: [
      { provider: "Chainlink Candlestick", env: ["CHAINLINK_CANDLESTICK_USER", "CHAINLINK_CANDLESTICK_API_KEY"], together: true, url: "https://app.chain.link", note: "OHLC candles and latest prices for crypto, US equities, forex (Data Streams username + API key)" },
      { provider: "Chainlink Data Streams", env: ["CHAINLINK_DATA_STREAMS_API_KEY", "CHAINLINK_DATA_STREAMS_HMAC_SECRET"], together: true, url: "https://app.chain.link", note: "signed reports only for subscribed feeds (paid)" },
    ],
  },
  {
    feature: "DeFi on Robinhood Chain (TVL, protocols, DEX volume, fees, yields)",
    commands: ["splice defi", "splice defi protocols", "splice defi yields"],
    withoutKeys: "everything: DefiLlama public APIs",
    keys: [],
  },
  {
    feature: "Token & address security",
    commands: ["splice security token <address>"],
    withoutKeys: "GoPlus anonymous access (low limits)",
    keys: [{ provider: "GoPlus", env: ["GOPLUS_APP_KEY", "GOPLUS_APP_SECRET"], together: true, url: "https://gopluslabs.io/security-api", note: "optional: higher limits" }],
  },
  {
    feature: "Wallet portfolio",
    commands: ["splice wallet portfolio <address>"],
    withoutKeys: null,
    keys: [{ provider: "Zerion", env: ["ZERION_API_KEY"], url: "https://developers.zerion.io", note: "free developer key" }],
  },
  {
    feature: "GitHub data",
    commands: ["splice github repo <owner/repo>", "splice github contents <owner/repo> [path]"],
    withoutKeys: "the public GitHub API (60 requests/hour) and public raw files",
    keys: [{ provider: "GitHub", env: ["GITHUB_TOKEN"], url: "https://github.com/settings/personal-access-tokens", note: "5,000 requests/hour + code search (read-only token is enough)" }],
  },
  {
    feature: "Web search & page text",
    commands: ['splice web search "<query>"', "splice web extract <url>", 'splice web answer "<question>"'],
    withoutKeys: null,
    keys: [
      { provider: "Tavily", env: ["TAVILY_API_KEY"], url: "https://app.tavily.com", note: "free monthly credits" },
      { provider: "Exa", env: ["EXA_API_KEY"], url: "https://dashboard.exa.ai/api-keys", note: "pay per request" },
      { provider: "Firecrawl", env: ["FIRECRAWL_API_KEY"], url: "https://www.firecrawl.dev/app/api-keys", note: "free credits" },
    ],
  },
  {
    feature: "AI: ask anything (agent over live data) and completions",
    commands: ['splice ask "<question>"', "splice chat", 'splice ai generate "<prompt>"'],
    withoutKeys: null,
    keys: [
      { provider: "OpenRouter", env: ["OPENROUTER_API_KEY"], url: "https://openrouter.ai/keys", note: "default provider (model openai/gpt-4o-mini unless AI_DEFAULT_MODEL / AI_ASK_MODEL is set)" },
      { provider: "Gemini", env: ["GEMINI_API_KEY"], url: "https://aistudio.google.com/apikey", note: "optional second provider; set GEMINI_DEFAULT_MODEL" },
    ],
  },
  {
    feature: "Extra RPC / indexing",
    commands: ["splice providers"],
    withoutKeys: null,
    keys: [
      { provider: "Goldsky Edge RPC", env: ["GOLDSKY_API_KEY"], url: "https://app.goldsky.com", note: "use the gs_edge_… key from the Edge RPC page" },
      { provider: "The Graph", env: ["THEGRAPH_API_KEY"], url: "https://thegraph.com/studio/apikeys/", note: "subgraph queries" },
    ],
  },
];

/** Per key: is any of its variables set (values are never returned). */
export function setupStatus(values: ProviderEnv): Array<SetupFeature & { keys: Array<SetupKey & { set: boolean }> }> {
  return SETUP_GUIDE.map((f) => ({ ...f, keys: f.keys.map((k) => ({ ...k, set: k.together ? k.env.every((name) => Boolean(values[name as keyof ProviderEnv])) : k.env.some((name) => Boolean(values[name as keyof ProviderEnv])) })) }));
}

/** A `.env.local` template: variable names and comments only, no values. */
export function setupTemplate(): string {
  const lines = ["# Splice provider keys (read only from these variable names). Never commit this file.", "# Everything is optional: without keys Splice uses keyless providers where they exist.", ""];
  for (const f of SETUP_GUIDE) {
    lines.push(`# --- ${f.feature}${f.withoutKeys ? ` (works without keys: ${f.withoutKeys})` : ""}`);
    for (const k of f.keys) {
      lines.push(`# ${k.provider}: ${k.url}${k.note ? ` — ${k.note}` : ""}`);
      for (const name of k.together ? k.env : [k.env[0]!]) lines.push(`${name}=`);
    }
    lines.push("");
  }
  lines.push("# AI routing (not secret)", "AI_PROVIDER=openrouter", "AI_DEFAULT_MODEL=", "AI_ASK_MODEL=", "GEMINI_DEFAULT_MODEL=", "");
  return lines.join("\n");
}
