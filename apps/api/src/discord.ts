/**
 * Splice Discord bot (HTTP interactions endpoint). Slash commands answer with the same text as the
 * Telegram bot. Every request is verified against the application's Ed25519 public key before it is
 * read. Replies are plain text with mentions disabled. Alerts are delivered on Telegram only.
 */
import { BOT_COMMANDS, displayName, telegramReply, type TelegramDeps } from "./telegram.js";

/** Slash commands and the name of their single text option (null = no option). */
export const DISCORD_COMMANDS: Array<{ name: string; description: string; option?: { name: string; description: string } }> = [
  { name: "splice", description: "$SPLICE price, market cap, liquidity" },
  { name: "holders", description: "$SPLICE top holders and the dev wallet" },
  { name: "burned", description: "How much $SPLICE is burned" },
  { name: "ca", description: "The official contract address" },
  { name: "tvl", description: "Robinhood Chain total value locked" },
  { name: "perps", description: "Perpetual markets by volume" },
  { name: "stocks", description: "Stock tokens: premium or discount" },
  { name: "stock", description: "One stock token", option: { name: "symbol", description: "Ticker, e.g. NVDA" } },
  { name: "filings", description: "A company's latest SEC filings", option: { name: "symbol", description: "Ticker, e.g. NVDA" } },
  { name: "odds", description: "Prediction-market odds: Fed, inflation, stocks" },
  { name: "new", description: "Newest tokens with security flags" },
  { name: "check", description: "Security flags for a token contract", option: { name: "address", description: "Token contract address (0x…)" } },
  { name: "wallet", description: "What a wallet holds", option: { name: "address", description: "Wallet address (0x…)" } },
  { name: "ask", description: "Ask a question in plain English", option: { name: "question", description: "Your question" } },
  { name: "links", description: "Website, docs, GitHub" },
  { name: "help", description: "Everything this bot can do" },
];
const NAMES = new Set(DISCORD_COMMANDS.map((c) => c.name));

const hex = (s: string): Uint8Array | null => (/^(?:[0-9a-f]{2})+$/i.test(s) ? Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16)) : null);

/** True when `signature` is the application's Ed25519 signature over timestamp + body. */
export async function verifyDiscordSignature(publicKeyHex: string, signatureHex: string | null, timestamp: string | null, body: string): Promise<boolean> {
  const key = hex(publicKeyHex);
  const signature = signatureHex ? hex(signatureHex) : null;
  if (!key || key.length !== 32 || !signature || signature.length !== 64 || !timestamp) return false;
  try {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/** The reply text for a slash command. */
export async function discordReply(command: string, input: string, channelId: string, deps: TelegramDeps, name: string): Promise<string> {
  if (!NAMES.has(command)) return "Unknown command. See /help.";
  if (command === "help") {
    // The Telegram command list without its alert block; alerts are delivered on Telegram.
    const end = BOT_COMMANDS.findIndex((line) => line.startsWith("Alerts"));
    return [`Here is what I can do, ${name}.`, "", ...BOT_COMMANDS.slice(0, end), "Alerts (price, large trades, burns, new tokens): t.me/spliceloombot", "", "/links — website, docs, GitHub"].join("\n");
  }
  const { alerts: _alerts, ...rest } = deps;
  try {
    const text = (await telegramReply(`/${command} ${input}`.trim(), `discord:${channelId}`, rest, name)) ?? "Unknown command. See /help.";
    // The shared replies point at alert commands; on Discord they point at the Telegram bot instead.
    return text.replace(/\/(?:burns|radar|whales) on\b/g, "t.me/spliceloombot");
  } catch {
    return `Sorry ${name}, that did not work right now. Try again in a minute.`;
  }
}

export interface DiscordContext {
  /** Runs after the response is sent (Workers waitUntil). Without it the reply is sent inline. */
  background?: (task: Promise<unknown>) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Handles a verified interaction and returns the response body. */
export async function handleDiscordInteraction(interaction: unknown, deps: TelegramDeps, ctx: DiscordContext = {}): Promise<Record<string, unknown>> {
  const i = (interaction ?? {}) as { type?: number; application_id?: unknown; token?: unknown; channel_id?: unknown; data?: { name?: unknown; options?: Array<{ value?: unknown }> }; member?: { user?: { global_name?: unknown; username?: unknown } }; user?: { global_name?: unknown; username?: unknown } };
  if (i.type === 1) return { type: 1 };
  if (i.type !== 2) return { type: 4, data: { content: "Unsupported interaction.", allowed_mentions: { parse: [] } } };
  const command = typeof i.data?.name === "string" ? i.data.name.toLowerCase() : "";
  const raw = i.data?.options?.[0]?.value;
  const input = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 320) : "";
  const user = i.member?.user ?? i.user;
  const name = displayName({ first_name: user?.global_name, username: user?.username });
  const channelId = typeof i.channel_id === "string" ? i.channel_id : "dm";
  const message = (text: string) => ({ content: text.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 });
  const appId = typeof i.application_id === "string" && /^\d{5,25}$/.test(i.application_id) ? i.application_id : null;
  const token = typeof i.token === "string" && /^[\w.\-]{20,400}$/.test(i.token) ? i.token : null;
  if (!ctx.background || !ctx.fetch || !appId || !token) return { type: 4, data: message(await discordReply(command, input, channelId, deps, name)) };
  // Discord waits 3 seconds for a response: acknowledge now, then fill in the reply.
  const send = ctx.fetch;
  ctx.background(
    discordReply(command, input, channelId, deps, name).then((text) =>
      send(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(message(text)) }).catch(() => undefined),
    ),
  );
  return { type: 5 };
}
