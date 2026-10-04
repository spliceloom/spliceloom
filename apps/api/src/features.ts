/**
 * Data behind the website's tool pages: stock-token premiums, the new-token screener, the wallet
 * view and the contract explainer. Every value comes from a provider result; a source that fails is
 * reported with its status, never filled in. Keyless or already-configured providers only.
 */
import { isLive, type DataResult, type SpliceData } from "@spliceloom/data";

type Section = { status: string; source?: string; fetchedAt?: string; reason?: string };
const sectionOf = (r: unknown): Section => {
  const x = (r ?? {}) as { status?: string; provenance?: { source?: string; fetchedAt?: string }; reason?: string; message?: string };
  const out: Section = { status: x.status ?? "UNAVAILABLE" };
  if (x.provenance?.source) out.source = x.provenance.source;
  if (x.provenance?.fetchedAt) out.fetchedAt = x.provenance.fetchedAt;
  const reason = x.reason ?? x.message;
  if (reason) out.reason = reason;
  return out;
};
const live = <T>(r: unknown): T | undefined => (r && isLive(r as DataResult<T>) ? (r as { data: T }).data : undefined);
const num = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ------------------------------------------------------------------------------ stock premiums

/** A Robinhood quote wider than this is not a price reference (closed market). */
const MAX_REFERENCE_SPREAD_PCT = 2;

/**
 * Robinhood Stock Tokens: the DEX price on Robinhood Chain next to a reference price for the token.
 * premiumPct = DEX ÷ reference − 1. The reference is Robinhood's own quote while it is tight, and the
 * stock's last close when the market is shut; every row names which one it used.
 */
export async function stockPremiums(data: SpliceData, limit = 20): Promise<Record<string, unknown>> {
  const movers = await data.stocks.movers({ kind: "volume", limit });
  const pools = live<{ pools: Array<{ baseToken?: { symbol?: string; name?: string; address?: string }; priceUsd?: string; liquidityUsd?: string; volumeUsd?: { h24?: string }; priceChangePct?: { h24?: string }; name?: string }> }>(movers)?.pools ?? [];
  const rows = await Promise.all(
    pools.map(async (p) => {
      const symbol = (p.baseToken?.symbol ?? "").toUpperCase();
      const quote = symbol ? await data.stocks.price(symbol) : undefined;
      const q = live<{ bid?: string; ask?: string; tokenBid?: string; tokenAsk?: string; generatedAt?: string; isTradingHalt?: boolean; deployments?: Array<{ contractAddress?: string; chainId?: number }> }>(quote);
      // Only the official token: the pool's token must be the contract Robinhood lists for this symbol
      // (look-alike tokens reuse stock tickers).
      const official = (q?.deployments ?? []).some((dep) => dep.chainId === 4663 && dep.contractAddress?.toLowerCase() === p.baseToken?.address?.toLowerCase());
      const dex = num(p.priceUsd);
      const tokenBid = num(q?.tokenBid);
      const tokenAsk = num(q?.tokenAsk);
      const stockBid = num(q?.bid);
      const stockAsk = num(q?.ask);
      const mid = tokenBid !== null && tokenAsk !== null ? (tokenBid + tokenAsk) / 2 : null;
      const spreadPct = mid && tokenBid !== null && tokenAsk !== null ? ((tokenAsk - tokenBid) / mid) * 100 : null;
      // Robinhood's quote is only a usable reference while it is tight. When the US market is closed
      // its bid and ask drift far apart; then the last close of the stock (Finnhub) × the token's
      // multiplier is the reference, and the row says so.
      let reference = spreadPct !== null && spreadPct <= MAX_REFERENCE_SPREAD_PCT ? mid : null;
      let referenceSource: "robinhood-quote" | "last-close" | null = reference !== null ? "robinhood-quote" : null;
      let close: unknown;
      if (reference === null && official) {
        close = await data.equities.quote(symbol);
        const last = num(live<{ priceUsd?: number }>(close)?.priceUsd);
        const multiplier = tokenBid !== null && stockBid ? tokenBid / stockBid : 1;
        if (last !== null) {
          reference = last * multiplier;
          referenceSource = "last-close";
        }
      }
      return {
        symbol,
        name: p.baseToken?.name ?? null,
        address: p.baseToken?.address ?? null,
        pool: p.name ?? null,
        dexPriceUsd: dex,
        referencePriceUsd: reference,
        referenceSource,
        referenceTime: referenceSource === "last-close" ? (live<{ time?: string }>(close)?.time ?? null) : (q?.generatedAt ?? null),
        quoteSpreadPct: spreadPct,
        stockPriceUsd: stockBid !== null && stockAsk !== null ? (stockBid + stockAsk) / 2 : null,
        premiumPct: dex !== null && reference ? (dex / reference - 1) * 100 : null,
        change24hPct: num(p.priceChangePct?.h24),
        volume24hUsd: num(p.volumeUsd?.h24),
        liquidityUsd: num(p.liquidityUsd),
        quotedAt: q?.generatedAt ?? null,
        halted: q?.isTradingHalt ?? null,
        official,
        reference: referenceSource === "last-close" ? sectionOf(close) : sectionOf(quote),
      };
    }),
  );
  const tokens = rows.filter((r) => r.symbol && r.official);
  return {
    chain: "robinhood",
    formula: "premiumPct = DEX price ÷ reference price − 1; reference = mid of Robinhood's token bid/ask while their spread is ≤ 2%, otherwise the stock's last close (Finnhub) × the token multiplier",
    tokens,
    excluded: rows.filter((r) => r.symbol && !r.official).length,
    // "closed" when no row has a tight Robinhood quote right now.
    session: tokens.some((r) => r.referenceSource === "robinhood-quote") ? "quoted" : "closed",
    sources: { dex: sectionOf(movers), reference: tokens.find((r) => r.reference.status === "LIVE")?.reference ?? tokens[0]?.reference ?? { status: "UNAVAILABLE" } },
  };
}
// ------------------------------------------------------------------------------------ screener

const FLAG_FIELDS: Array<[string, string, "danger" | "warn"]> = [
  ["is_honeypot", "honeypot", "danger"],
  ["cannot_buy", "cannot buy", "danger"],
  ["hidden_owner", "hidden owner", "danger"],
  ["selfdestruct", "self-destruct", "danger"],
  ["can_take_back_ownership", "ownership can be reclaimed", "warn"],
  ["is_mintable", "mintable", "warn"],
  ["is_proxy", "proxy", "warn"],
  ["is_blacklisted", "blacklist", "warn"],
  ["slippage_modifiable", "tax can change", "warn"],
];

export function securityFlags(report: Record<string, unknown> | undefined): Array<{ level: "danger" | "warn" | "ok"; text: string }> | null {
  if (!report) return null;
  const flags: Array<{ level: "danger" | "warn" | "ok"; text: string }> = [];
  for (const [field, text, level] of FLAG_FIELDS) if (report[field] === "1") flags.push({ level, text });
  for (const [field, label] of [["buy_tax", "buy tax"], ["sell_tax", "sell tax"]] as const) {
    const tax = num(report[field]);
    if (tax !== null && tax * 100 >= 5) flags.push({ level: tax * 100 >= 20 ? "danger" : "warn", text: `${label} ${(tax * 100).toFixed(0)}%` });
  }
  if (report.is_open_source === "0") flags.push({ level: "warn", text: "source not verified" });
  if (flags.length === 0) flags.push({ level: "ok", text: "no GoPlus flags" });
  return flags;
}

/** Newest pools on Robinhood Chain with a GoPlus security check per token (first `limit` pools). */
export async function screener(data: SpliceData, limit = 14): Promise<Record<string, unknown>> {
  const pools = await data.market.newPools("robinhood");
  const list = (live<{ pools: Array<any> }>(pools)?.pools ?? []).slice(0, limit);
  const rows = await Promise.all(
    list.map(async (p) => {
      const address: string | undefined = p.baseToken?.address;
      const sec = address && ADDRESS.test(address) ? await data.security.token(address) : undefined;
      const report = live<{ report?: Record<string, unknown> }>(sec)?.report;
      return {
        symbol: p.baseToken?.symbol ?? null,
        name: p.baseToken?.name ?? null,
        address: address ?? null,
        pool: p.name ?? null,
        dex: p.dex ?? null,
        priceUsd: num(p.priceUsd),
        liquidityUsd: num(p.liquidityUsd),
        volume24hUsd: num(p.volumeUsd?.h24),
        buys24h: num(p.transactions?.h24?.buys),
        sells24h: num(p.transactions?.h24?.sells),
        createdAt: p.createdAt ?? null,
        flags: securityFlags(report),
        security: sec ? sectionOf(sec) : { status: "UNAVAILABLE" },
      };
    }),
  );
  return { chain: "robinhood", tokens: rows, sources: { pools: sectionOf(pools), security: rows.find((r) => r.security.status === "LIVE")?.security ?? { status: "UNAVAILABLE", source: "goplus" } } };
}

// -------------------------------------------------------------------------------------- wallet

/** Holdings of an address: native ETH and tokens, valued where a price source lists the token. */
export async function walletSummary(data: SpliceData, address: string, known: Record<string, number> = {}): Promise<Record<string, unknown>> {
  const [balances, transfers, eth, risk] = await Promise.all([data.wallet.balances(address), data.onchain.transfers(address, { limit: 15 }), data.oracle.price("ETH"), data.security.address(address)]);
  const sections = "sections" in balances ? (balances.sections as Record<string, DataResult<any>>) : {};
  const native = live<{ formatted: string }>(sections.native);
  const tokens = (live<{ balances: Array<{ token: { address?: string; symbol?: string; name?: string; type?: string }; formatted?: string }> }>(sections.tokens)?.balances ?? []).filter((b) => b.token?.type === "ERC-20" && b.token.address && Number(b.formatted) > 0);
  // Prices for at most 40 tokens in one request (DefiLlama); tokens it does not list stay unpriced.
  const priced = tokens.slice(0, 40);
  const prices = priced.length ? await data.defi.tokenPrice(priced.map((t) => t.token.address!)) : undefined;
  const priceMap = new Map((live<{ prices: Array<{ address: string; priceUsd: string }> }>(prices)?.prices ?? []).map((p) => [p.address.toLowerCase(), Number(p.priceUsd)]));
  const ethUsd = num(live<{ price: string }>(eth)?.price);
  const nativeAmount = num(native?.formatted);
  const holdings = tokens
    .map((t) => {
      const amount = Number(t.formatted);
      // `known`: prices the API already computes itself (the $SPLICE pool price).
      const price = priceMap.get(t.token.address!.toLowerCase()) ?? known[t.token.address!.toLowerCase()] ?? null;
      return { address: t.token.address!, symbol: t.token.symbol ?? null, name: t.token.name ?? null, amount, priceUsd: price, valueUsd: price !== null ? amount * price : null };
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || b.amount - a.amount)
    .slice(0, 60);
  const nativeValue = nativeAmount !== null && ethUsd !== null ? nativeAmount * ethUsd : null;
  const pricedValue = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  const riskData = live<Record<string, unknown>>(risk);
  const riskFlags = riskData ? Object.entries((riskData.report as Record<string, unknown> | undefined) ?? riskData).filter(([, v]) => v === "1").map(([k]) => k.replace(/_/g, " ")) : null;
  return {
    address,
    chain: "robinhood",
    native: { symbol: "ETH", amount: nativeAmount, priceUsd: ethUsd, valueUsd: nativeValue },
    tokenCount: tokens.length,
    holdings,
    pricedValueUsd: (nativeValue ?? 0) + pricedValue,
    unpricedTokens: holdings.filter((h) => h.valueUsd === null).length,
    transfers: (live<{ transfers: Array<any> }>(transfers)?.transfers ?? []).map((t) => ({ hash: t.hash, time: t.timestamp, direction: String(t.to).toLowerCase() === address.toLowerCase() ? "in" : "out", counterparty: String(t.to).toLowerCase() === address.toLowerCase() ? t.from : t.to, symbol: t.token?.symbol ?? null, amount: num(t.formatted) })),
    riskFlags,
    sources: { native: sectionOf(sections.native), tokens: sectionOf(sections.tokens), prices: prices ? sectionOf(prices) : { status: "UNAVAILABLE" }, ethUsd: sectionOf(eth), transfers: sectionOf(transfers), risk: sectionOf(risk) },
  };
}

// ---------------------------------------------------------------------------- contract explainer

export interface ContractFacts {
  address: string;
  isContract: boolean | null;
  verified: boolean | null;
  name: string | null;
  compiler: string | null;
  proxy: boolean | null;
  functions: string[];
  events: string[];
  flags: ReturnType<typeof securityFlags>;
  sources: Record<string, Section>;
}

export async function contractFacts(data: SpliceData, address: string): Promise<ContractFacts> {
  const [contract, security] = await Promise.all([data.onchain.contract(address), data.security.token(address)]);
  const s = "sections" in contract ? (contract.sections as Record<string, DataResult<any>>) : {};
  const code = live<{ isContract?: boolean }>(s.code);
  const verified = live<{ verified?: boolean; name?: string; compilerVersion?: string; functions?: string[]; events?: string[] }>(s.verified);
  const proxy = live<{ isProxy?: boolean }>(s.proxy);
  return {
    address,
    isContract: code?.isContract ?? null,
    verified: verified?.verified ?? null,
    name: verified?.name ?? null,
    compiler: verified?.compilerVersion ?? null,
    proxy: proxy?.isProxy ?? null,
    functions: (verified?.functions ?? []).slice(0, 80),
    events: (verified?.events ?? []).slice(0, 40),
    flags: securityFlags(live<{ report?: Record<string, unknown> }>(security)?.report),
    sources: { code: sectionOf(s.code), verified: sectionOf(s.verified), proxy: sectionOf(s.proxy), security: sectionOf(security) },
  };
}

/** A plain-language explanation of a contract from its verified interface and GoPlus flags. Not an audit. */
export async function explainContract(data: SpliceData, facts: ContractFacts, model?: string): Promise<{ text: string; model: string | null; costUsd: number } | { error: string }> {
  if (!facts.isContract) return { error: "This address is not a contract on Robinhood Chain." };
  if (!facts.verified || facts.functions.length === 0) return { error: "This contract's source is not verified on Blockscout, so its functions are not known. Nothing to explain." };
  const input: Parameters<SpliceData["ai"]["generate"]>[0] = {
    messages: [
      {
        role: "system",
        content:
          "You explain smart contracts to non-developers. You are given the verified interface of a contract (function and event signatures) and automated security flags. Explain in plain English what the contract appears to do, who can call the privileged functions, and what a holder should pay attention to. Rules: use only the given facts; never invent functions, addresses or numbers; say clearly that this is based on the interface and automated flags, not a review of the source code or an audit; no financial advice; under 220 words; short paragraphs or a short bullet list, no tables, no links.",
      },
      { role: "user", content: JSON.stringify({ name: facts.name, compiler: facts.compiler, isProxy: facts.proxy, functions: facts.functions, events: facts.events, securityFlags: facts.flags }) },
    ],
    maxTokens: 600,
    temperature: 0.2,
  };
  if (model) input.model = model;
  const result = await data.ai.generate(input);
  if (!isLive(result)) return { error: "The model is unavailable right now. Try again shortly." };
  return { text: result.data.text?.trim() ?? "", model: result.data.routing.actualModel ?? null, costUsd: result.data.usage?.costUsd ?? 0 };
}
