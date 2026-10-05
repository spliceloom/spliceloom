/**
 * Splice Telegram bot (webhook). Commands answer from the same live data as the website; replies are
 * returned in the webhook response. Alerts (price, large trades, burns, new tokens) are delivered by
 * the scheduled job in telegram-alerts.ts. Plain text only: nothing a user sends is interpreted as
 * markup, and names are shown as text.
 */
export type AlertKind = "above" | "below" | "whale" | "burn" | "radar" | "premium";

export interface AlertRow {
  id: number;
  chatId: string;
  kind: AlertKind;
  value: number | null;
}

export interface AlertStore {
  /** Adds an alert; whale / burn / radar are one per chat (the new value replaces the old one). */
  add(chatId: string, kind: AlertKind, value: number | null): Promise<void>;
  list(chatId: string): Promise<AlertRow[]>;
  remove(chatId: string, which: number | "all" | AlertKind): Promise<number>;
  all(): Promise<AlertRow[]>;
  removeById(id: number): Promise<void>;
}

export interface TelegramDeps {
  token: () => Promise<Record<string, any>>;
  chain: () => Promise<Record<string, any>>;
  stocks: () => Promise<Record<string, any>>;
  screener: () => Promise<Record<string, any>>;
  wallet: (address: string) => Promise<Record<string, any>>;
  stock: (symbol: string) => Promise<string>;
  check: (address: string) => Promise<string>;
  ask: (question: string, chatId: string) => Promise<string>;
  /** Latest SEC filings of a ticker; null when SEC lists no filer for it. */
  filings?: (symbol: string) => Promise<Record<string, any> | null>;
  /** Prediction-market odds (Polymarket). */
  odds?: () => Promise<Record<string, any>>;
  alerts?: AlertStore;
  /** The wallet linked to a chat and whether it holds enough $SPLICE right now; null when no wallet is linked. */
  holder?: (chatId: string) => Promise<{ address: string; holder: boolean } | null>;
  /** The page where a chat links a wallet (sign a message; no transaction). */
  holderLink?: (chatId: string) => Promise<string>;
  now?: () => number;
}

export const MAX_ALERTS_PER_CHAT = 10;
/** Chats with a linked wallet holding enough $SPLICE. */
export const MAX_ALERTS_PER_HOLDER_CHAT = 30;

/**
 * Features holders get first: open to linked holder chats now, to everyone from the date given.
 * A feature is removed from this list once it is open to all.
 */
export const EARLY_ACCESS: Record<string, string> = { premium: "2026-10-07T12:00:00Z" };
export const holdersOnly = (feature: string, now: number): boolean => Boolean(EARLY_ACCESS[feature]) && now < Date.parse(EARLY_ACCESS[feature]!);

const COMMANDS = [
  "$SPLICE",
  "/splice — price, market cap, liquidity, 24h change",
  "/holders — top holders and the launch pool",
  "/burned — how much is burned",
  "/ca — the official contract address",
  "",
  "Robinhood Chain",
  "/tvl — total value locked",
  "/perps — perpetual markets by volume",
  "/stocks — stock tokens: premium or discount",
  "/stock NVDA — one stock token",
  "/filings NVDA — the company's latest SEC filings",
  "/odds — prediction-market odds: Fed, inflation, stocks",
  "/new — newest tokens with security flags",
  "/check 0x… — security flags for a token contract",
  "/wallet 0x… — what a wallet holds",
  "/ask <question> — ask in plain English",
  "",
  "Alerts (sent to this chat)",
  "/alert above 0.00002 — $SPLICE price alert (or: below)",
  "/whales on 100 — $SPLICE trades of $100 or more",
  "/burns on — every new $SPLICE burn",
  "/radar on 10000 — new tokens with $10,000+ liquidity",
  "/premium on 2 — stock tokens trading 2%+ away from their reference price",
  "/alerts — your alerts · /alertoff 2 — remove one (or: all)",
  "",
  "Holders",
  "/holder — link a wallet holding 100,000+ $SPLICE: 30 alerts, 50 questions a day, new features first",
  "",
  "/invite — add me to a group",
  "/links — website, docs, GitHub",
];
export { COMMANDS as BOT_COMMANDS };

const usd = (v: unknown): string => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  // Dust (e.g. an empty pool) is zero for display; small prices keep four significant digits.
  return Math.abs(n) < 1e-9 ? "$0" : `$${n.toPrecision(4)}`;
};
const pct = (v: unknown): string => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
};
const amount = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a";
};
const short = (a: unknown): string => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "?"));
export { usd as tgUsd, pct as tgPct, amount as tgAmount, short as tgShort };

/** A display name safe to echo: one line, no control characters, at most 32 characters. */
export function displayName(from: { first_name?: unknown; username?: unknown } | undefined): string {
  const raw = typeof from?.first_name === "string" && from.first_name.trim() ? from.first_name : typeof from?.username === "string" ? from.username : "";
  return raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 32) || "there";
}

const ALERT_TEXT: Record<AlertKind, (v: number | null) => string> = {
  above: (v) => `$SPLICE price at or above ${usd(v)}`,
  below: (v) => `$SPLICE price at or below ${usd(v)}`,
  whale: (v) => `$SPLICE trades of ${usd(v)} or more`,
  burn: () => "every new $SPLICE burn",
  radar: (v) => `new tokens with ${usd(v)}+ liquidity`,
  premium: (v) => `stock tokens ${Number(v).toFixed(1)}%+ away from their reference price`,
};
export const describeAlert = (a: Pick<AlertRow, "kind" | "value">) => ALERT_TEXT[a.kind](a.value);

async function alertCommand(command: string, arg: string, chatId: string, store: AlertStore | undefined, isHolder: boolean, now: number): Promise<string> {
  if (!store) return "Alerts are not available right now.";
  const parts = arg.split(/\s+/).filter(Boolean);
  const cap = isHolder ? MAX_ALERTS_PER_HOLDER_CHAT : MAX_ALERTS_PER_CHAT;
  const full = async () => (await store.list(chatId)).length >= cap;
  const fullText = isHolder ? `This chat already has ${cap} alerts. Remove one with /alertoff first.` : `This chat already has ${cap} alerts. Remove one with /alertoff first, or link a holder wallet for ${MAX_ALERTS_PER_HOLDER_CHAT}: /holder`;
  if (command === "alerts") {
    const list = await store.list(chatId);
    return list.length ? ["Alerts in this chat:", ...list.map((a) => `${a.id}. ${describeAlert(a)}`), "", "Remove one with /alertoff <number>, or /alertoff all."].join("\n") : "No alerts in this chat yet. Try /alert above 0.00002, /whales on, /burns on or /radar on.";
  }
  if (command === "alertoff") {
    if (!parts[0]) return "Usage: /alertoff 2   (the number from /alerts), or /alertoff all";
    const which = parts[0].toLowerCase() === "all" ? "all" : Number(parts[0]);
    if (which !== "all" && !Number.isInteger(which)) return "Usage: /alertoff 2   (the number from /alerts), or /alertoff all";
    const removed = await store.remove(chatId, which);
    return removed ? `Removed ${removed} alert${removed === 1 ? "" : "s"}.` : "No alert with that number in this chat. See /alerts.";
  }
  if (command === "alert") {
    const kind = (parts[0] ?? "").toLowerCase();
    const value = Number(parts[1]);
    if ((kind !== "above" && kind !== "below") || !Number.isFinite(value) || value <= 0) return "Usage: /alert above 0.00002   or   /alert below 0.00001   ($SPLICE price in USD)";
    if (await full()) return fullText;
    await store.add(chatId, kind, value);
    return `Alert set: ${describeAlert({ kind, value })}. I'll message this chat once when it happens.`;
  }
  // /whales, /burns, /radar, /premium: on [value] | off
  const kind: "whale" | "burn" | "radar" | "premium" = command === "whales" ? "whale" : command === "burns" ? "burn" : command === "premium" ? "premium" : "radar";
  const mode = (parts[0] ?? "").toLowerCase();
  const label = { whale: "large-trade alerts", burn: "burn alerts", radar: "new-token alerts", premium: "stock token premium alerts" }[kind];
  if (mode === "off") return (await store.remove(chatId, kind)) ? `Turned off ${label}.` : `There were no ${label} in this chat.`;
  if (mode !== "on") {
    return kind === "whale"
      ? "Usage: /whales on 100   (minimum trade size in USD), or /whales off"
      : kind === "burn"
        ? "Usage: /burns on, or /burns off"
        : kind === "premium"
          ? "Usage: /premium on 2   (minimum gap in percent between the DEX price and the reference price), or /premium off"
          : "Usage: /radar on 10000   (minimum liquidity in USD), or /radar off";
  }
  // Holders get new alert types first (see EARLY_ACCESS).
  if (holdersOnly(kind, now) && !isHolder) {
    return `Stock token premium alerts are open to $SPLICE holders first, and to everyone from ${EARLY_ACCESS[kind]!.slice(0, 10)}. Link a wallet holding 100,000+ $SPLICE with /holder.`;
  }
  const defaults = { whale: 100, burn: null, radar: 10_000, premium: 2 } as const;
  const minimums = { whale: 10, burn: 0, radar: 1_000, premium: 0.5 } as const;
  let value: number | null = defaults[kind];
  if (kind !== "burn" && parts[1] !== undefined) {
    value = Number(parts[1]);
    if (!Number.isFinite(value) || value < minimums[kind]) return kind === "premium" ? `The minimum is ${minimums.premium}%.` : `The minimum is ${usd(minimums[kind])}.`;
    if (kind === "premium" && value > 50) return "The maximum is 50%.";
  }
  const existing = (await store.list(chatId)).some((a) => a.kind === kind);
  if (!existing && (await full())) return fullText;
  await store.add(chatId, kind, value);
  return `On: ${describeAlert({ kind, value })}. Turn it off with /${command} off.`;
}

/** Text for one command; null when the message is not for the bot. */
export async function telegramReply(text: string, chatId: string, deps: TelegramDeps, name = "there"): Promise<string | null> {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  switch (command) {
    case "start": {
      // The greeting must not fail when the token summary is unavailable; the contract line is then left out.
      const address = await deps.token().then((t) => String(t.address), () => null);
      return [
        `Hi ${name}, I'm Splice.`,
        "",
        "I read Robinhood Chain live and tell you what I find, with the source of every number: the $SPLICE token, stock tokens, perps, new tokens and their security flags, any wallet. I can also message this chat when something happens: a price level, a large trade, a burn, a new token.",
        "",
        ...(address ? ["The only official $SPLICE contract (Robinhood Chain):", address, ""] : []),
        "Try /splice or /tvl, or ask me in plain English: /ask what are the top perp markets?",
        "",
        "All commands: /help",
        "Market data, not financial advice.",
      ].join("\n");
    }
    case "help":
      return [`Here is what I can do, ${name}.`, "", ...COMMANDS].join("\n");
    case "splice":
    case "price": {
      const t = await deps.token();
      const st = t.market?.stats ?? {};
      return [
        `${name}, here is $SPLICE right now:`,
        `Price: ${usd(t.priceUsd ?? st.priceUsd)}   24h: ${pct(st.changePct?.h24)}`,
        `Market cap: ${usd(t.fdvUsd)}   Liquidity: ${usd(t.pool?.liquidityUsd)}`,
        `Volume 24h: ${usd(st.volumeUsd?.h24)}   Trades 24h: ${amount(st.txns24)}`,
        `Holders: ${t.holders ?? "n/a"}   Burned: ${Number.isFinite(Number(t.burned?.pctOfSupply)) ? `${Number(t.burned.pctOfSupply).toFixed(2)}%` : "n/a"}`,
        "Chart and live trades: spliceloom.com/token",
      ].join("\n");
    }
    case "ca":
    case "contract": {
      const t = await deps.token();
      return [`${name}, the only official $SPLICE contract (Robinhood Chain):`, String(t.address), "", "It is also on spliceloom.com and @spliceloom. Any other token using the Splice name is not ours."].join("\n");
    }
    case "burned":
    case "burn": {
      const t = await deps.token();
      const b = t.burned ?? {};
      return [`${name}, burned $SPLICE so far:`, b.total !== null && b.total !== undefined ? `${amount(b.total)} SPLICE (${Number(b.pctOfSupply).toFixed(2)}% of supply)` : "unavailable right now", "Read from the dead address with balanceOf. Get a message on every new burn: /burns on"].join("\n");
    }
    case "holders": {
      const t = await deps.token();
      const top = (t.topHolders ?? []).slice(0, 8) as Array<{ address: string; pctOfSupply: number | null; label: string | null }>;
      if (!top.length) return `${name}, the holder list is unavailable right now.`;
      const tp = t.transparency ?? {};
      return [
        `${name}, $SPLICE has ${t.holders ?? "n/a"} holders. The largest:`,
        ...top.map((h, i) => `${i + 1}. ${short(h.address)}  ${h.pctOfSupply !== null ? `${Number(h.pctOfSupply).toFixed(2)}%` : "n/a"}${h.label ? `  (${h.label})` : ""}`),
        tp.deployer ? `Dev wallet (deployer): ${amount(tp.deployer.balance)} SPLICE` : "",
        "Source: Blockscout, token contract · spliceloom.com/token",
      ].filter(Boolean).join("\n");
    }
    case "tvl": {
      const c = await deps.chain();
      return [`${name}, Robinhood Chain TVL is ${c.tvl ? usd(c.tvl.tvlUsd) : "unavailable"}.`, c.tvl ? `1d ${pct(c.tvl.change1dPct)}   7d ${pct(c.tvl.change7dPct)}   30d ${pct(c.tvl.change30dPct)}` : "", "Source: DefiLlama · spliceloom.com/live"].filter(Boolean).join("\n");
    }
    case "perps": {
      const c = await deps.chain();
      const perps = (c.perps ?? []).slice(0, 8) as Array<any>;
      if (!perps.length) return `${name}, perp markets are unavailable right now.`;
      return [`${name}, the busiest perps on Robinhood Chain (24h volume):`, ...perps.map((p) => `${p.symbol}  ${usd(p.markPrice)}  ${pct(p.change24hPct)}  vol ${usd(p.volume24hUsd)}  OI ${usd(p.openInterestUsd)}`), "Source: Lighter · spliceloom.com/live"].join("\n");
    }
    case "stocks": {
      const s = await deps.stocks();
      const rows = ((s.tokens ?? []) as Array<any>).filter((t) => t.premiumPct !== null).sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct)).slice(0, 8);
      if (!rows.length) return `${name}, stock token data is unavailable right now.`;
      return [
        `${name}, stock tokens: DEX price vs reference.`,
        ...rows.map((t) => `${t.symbol}  ${usd(t.dexPriceUsd)} vs ${usd(t.referencePriceUsd)}  ${pct(t.premiumPct)}${t.referenceSource === "last-close" ? " (last close)" : ""}`),
        s.session === "closed" ? "US market closed: the reference is the last close." : "",
        "Details: spliceloom.com/stocks",
      ].filter(Boolean).join("\n");
    }
    case "stock":
      if (!/^[A-Za-z.]{1,8}$/.test(arg)) return `${name}, use it like this: /stock NVDA`;
      return `${name}, here you go.\n${await deps.stock(arg.toUpperCase())}`;
    case "filings": {
      if (!/^[A-Za-z.-]{1,8}$/.test(arg)) return `${name}, use it like this: /filings NVDA`;
      if (!deps.filings) return `${name}, filings are not available right now.`;
      const symbol = arg.toUpperCase();
      const f = await deps.filings(symbol);
      if (!f) return `${name}, SEC lists no filer for ${symbol}.`;
      const rows = ((f.filings ?? []) as Array<any>).slice(0, 8);
      if (!rows.length) return `${name}, no recent SEC filings for ${symbol}.`;
      return [
        `${name}, the latest SEC filings of ${f.company ?? symbol} (${symbol}):`,
        ...rows.map((r) => `${r.filedAt}  ${r.form}${r.label ? `  ${r.label}` : ""}${r.items?.length ? `: ${r.items.filter((i: string) => !i.startsWith("9.01")).join("; ")}` : ""}`),
        Number.isFinite(Number(f.insider?.filings30d)) ? `Insider forms (3, 4, 5, 144) in the last 30 days: ${f.insider.filings30d}` : "",
        "Source: SEC EDGAR · spliceloom.com/stocks",
      ].filter(Boolean).join("\n");
    }
    case "odds": {
      if (!deps.odds) return `${name}, prediction-market odds are not available right now.`;
      const o = await deps.odds();
      const events = [...((o.macro ?? []) as Array<any>).slice(0, 4), ...((o.stocks ?? []) as Array<any>).slice(0, 3)];
      if (!events.length) return `${name}, prediction-market odds are unavailable right now.`;
      return [
        `${name}, prediction-market odds right now:`,
        ...events.flatMap((e) => ["", e.title, (e.outcomes as Array<{ label: string; probability: number }>).map((x) => `${x.label} ${Math.round(x.probability * 100)}%`).join(" · ")]),
        "",
        "Source: Polymarket contract prices, not a forecast · spliceloom.com/live",
      ].join("\n");
    }
    case "new": {
      const s = await deps.screener();
      const rows = ((s.tokens ?? []) as Array<any>).slice(0, 8);
      if (!rows.length) return `${name}, new token data is unavailable right now.`;
      return [
        `${name}, the newest tokens on Robinhood Chain:`,
        ...rows.map((t) => `${t.symbol ?? "?"}  liq ${usd(t.liquidityUsd)}  vol ${usd(t.volume24hUsd)}  ${(t.flags ?? [{ text: "security n/a" }]).map((f: { text: string }) => f.text).join(", ")}`),
        "Listed automatically, not reviewed or endorsed. Most new tokens are high risk.",
        "Check one: /check 0x…   Alerts: /radar on",
      ].join("\n");
    }
    case "check":
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) return `${name}, use it like this: /check 0x<token contract address>`;
      return `${name}, here is what I found.\n${await deps.check(arg)}`;
    case "wallet": {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) return `${name}, use it like this: /wallet 0x<address>`;
      const w = await deps.wallet(arg);
      const top = ((w.holdings ?? []) as Array<any>).slice(0, 6);
      return [
        `${name}, wallet ${short(arg)} on Robinhood Chain:`,
        `ETH: ${w.native?.amount !== null && w.native?.amount !== undefined ? Number(w.native.amount).toFixed(5) : "n/a"} (${usd(w.native?.valueUsd)})`,
        `Tokens held: ${w.tokenCount ?? "n/a"}   Priced value: ${usd(w.pricedValueUsd)}`,
        ...top.map((h) => `${h.symbol ?? short(h.address)}  ${amount(h.amount)}${h.valueUsd !== null ? `  ${usd(h.valueUsd)}` : "  (no price source)"}`),
        w.unpricedTokens ? `${w.unpricedTokens} tokens have no price source, so the real value can be higher.` : "",
        `Full view: spliceloom.com/wallet?address=${arg}`,
      ].filter(Boolean).join("\n");
    }
    case "ask":
      if (!arg) return `${name}, ask me like this: /ask What is the TVL of Robinhood Chain?`;
      if (arg.length > 300) return `${name}, questions are limited to 300 characters.`;
      return `${name}, here is what the data says.\n\n${await deps.ask(arg, chatId)}`;
    case "alert":
    case "alerts":
    case "alertoff":
    case "whales":
    case "burns":
    case "radar":
    case "premium": {
      const linked = deps.holder ? await deps.holder(chatId).catch(() => null) : null;
      return `${name}: ${await alertCommand(command, arg, chatId, deps.alerts, Boolean(linked?.holder), (deps.now ?? Date.now)())}`;
    }
    case "holder": {
      if (!deps.holder || !deps.holderLink) return `${name}, holder access is not available right now.`;
      const linked = await deps.holder(chatId);
      const perks = `Holder chats get ${MAX_ALERTS_PER_HOLDER_CHAT} alerts instead of ${MAX_ALERTS_PER_CHAT}, 50 questions a day instead of 10, and new features first.`;
      if (linked?.holder) return [`${name}, this chat is linked to ${short(linked.address)}, which holds enough $SPLICE.`, perks, Object.keys(EARLY_ACCESS).length ? `Open to holders now: ${Object.keys(EARLY_ACCESS).map((f) => `/${f}`).join(", ")}` : ""].filter(Boolean).join("\n");
      const link = await deps.holderLink(chatId);
      return [
        linked ? `${name}, this chat is linked to ${short(linked.address)}, but that wallet no longer holds 100,000 $SPLICE.` : `${name}, link a wallet that holds 100,000+ $SPLICE to this chat.`,
        perks,
        "",
        "Open this page and sign a message with the wallet. It is a signature only: no transaction, no gas, no approval.",
        link,
      ].join("\n");
    }
    case "invite":
      return [`${name}, add me to a group and everyone there can use the commands:`, "t.me/spliceloombot?startgroup=true", "", "In groups I only answer commands, and alerts set in a group are sent to that group."].join("\n");
    case "links":
      return [`${name}, the official Splice links:`, "Website: spliceloom.com", "Docs: docs.spliceloom.com", "GitHub: github.com/spliceloom/spliceloom", "X: x.com/spliceloom", "Token: spliceloom.com/token"].join("\n");
    default:
      return null;
  }
}

/** Handles a Telegram update and returns the webhook response body (a sendMessage call, or {}). */
export async function handleTelegramUpdate(update: unknown, deps: TelegramDeps): Promise<Record<string, unknown>> {
  const message = (update as { message?: { text?: string; chat?: { id?: number | string }; message_id?: number; from?: { first_name?: unknown; username?: unknown } } })?.message;
  const chatId = message?.chat?.id;
  if (!message?.text || chatId === undefined) return {};
  const name = displayName(message.from);
  let text: string | null;
  try {
    text = await telegramReply(message.text, String(chatId), deps, name);
  } catch {
    text = `Sorry ${name}, that did not work right now. Try again in a minute.`;
  }
  if (!text) return {};
  return { method: "sendMessage", chat_id: chatId, text: text.slice(0, 3900), reply_to_message_id: message.message_id, allow_sending_without_reply: true, disable_web_page_preview: true };
}
