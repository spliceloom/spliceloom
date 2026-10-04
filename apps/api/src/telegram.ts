/**
 * Splice Telegram bot (webhook). Commands answer from the same live data as the website; replies are
 * returned in the webhook response, so the bot token is only needed to register the webhook.
 * Plain text only: nothing a user sends is interpreted as markup.
 */
export interface TelegramDeps {
  token: () => Promise<Record<string, any>>;
  chain: () => Promise<Record<string, any>>;
  stock: (symbol: string) => Promise<string>;
  check: (address: string) => Promise<string>;
  ask: (question: string, chatId: string) => Promise<string>;
}

const HELP = [
  "Splice — live Robinhood Chain data.",
  "",
  "/splice — $SPLICE price, market cap, liquidity, burned",
  "/tvl — Robinhood Chain TVL and top perps",
  "/stock NVDA — a Robinhood stock token, every source",
  "/check 0x… — security flags for a token contract",
  "/ask <question> — ask in plain English (limited per chat)",
  "",
  "Web: spliceloom.com/live · CLI: npm i -g @spliceloom/cli",
  "Market data, not financial advice.",
].join("\n");

const usd = (v: unknown): string => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return n === 0 ? "$0" : `$${n.toPrecision(4)}`;
};
const pct = (v: unknown): string => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
};

/** Text for one command; null when the message is not for the bot. */
export async function telegramReply(text: string, chatId: string, deps: TelegramDeps): Promise<string | null> {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  switch (command) {
    case "start":
    case "help":
      return HELP;
    case "splice":
    case "price": {
      const t = await deps.token();
      const st = t.market?.stats ?? {};
      return [
        "$SPLICE on Robinhood Chain",
        `Price: ${usd(t.priceUsd ?? st.priceUsd)}   24h: ${pct(st.changePct?.h24)}`,
        `Market cap: ${usd(t.fdvUsd)}   Liquidity: ${usd(t.pool?.liquidityUsd)}`,
        `Holders: ${t.holders ?? "n/a"}   Burned: ${t.burned?.pctOfSupply ?? "n/a"}%`,
        `CA: ${t.address}`,
        "Live: spliceloom.com/token",
      ].join("\n");
    }
    case "tvl": {
      const c = await deps.chain();
      const perps = (c.perps ?? []).slice(0, 3).map((p: any) => `${p.symbol} ${usd(p.volume24hUsd)}`).join(", ");
      return [`Robinhood Chain TVL: ${c.tvl ? usd(c.tvl.tvlUsd) : "n/a"} (1d ${pct(c.tvl?.change1dPct)}, 30d ${pct(c.tvl?.change30dPct)})`, perps ? `Top perps by volume: ${perps}` : "", "Source: DefiLlama, Lighter · spliceloom.com/live"].filter(Boolean).join("\n");
    }
    case "stock":
      if (!/^[A-Za-z.]{1,8}$/.test(arg)) return "Usage: /stock NVDA";
      return deps.stock(arg.toUpperCase());
    case "check":
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) return "Usage: /check 0x<token contract address>";
      return deps.check(arg);
    case "ask":
      if (!arg) return "Usage: /ask What is the TVL of Robinhood Chain?";
      if (arg.length > 300) return "Questions are limited to 300 characters.";
      return deps.ask(arg, chatId);
    default:
      return null;
  }
}

/** Handles a Telegram update and returns the webhook response body (a sendMessage call, or {}). */
export async function handleTelegramUpdate(update: unknown, deps: TelegramDeps): Promise<Record<string, unknown>> {
  const message = (update as { message?: { text?: string; chat?: { id?: number | string }; message_id?: number } })?.message;
  const chatId = message?.chat?.id;
  if (!message?.text || chatId === undefined) return {};
  let text: string | null;
  try {
    text = await telegramReply(message.text, String(chatId), deps);
  } catch {
    text = "That did not work right now. Try again in a minute.";
  }
  if (!text) return {};
  return { method: "sendMessage", chat_id: chatId, text: text.slice(0, 3900), reply_to_message_id: message.message_id, allow_sending_without_reply: true, disable_web_page_preview: true };
}
