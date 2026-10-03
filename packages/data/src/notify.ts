/**
 * Alert delivery to Discord (incoming webhook) and Telegram (bot API).
 *
 * Credentials come only from the provider environment (DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID) and are redacted from every error. Requests go through the same guarded HTTP
 * client as data providers, limited to discord.com / discordapp.com and api.telegram.org.
 */
import type { HttpClient } from "./http.js";
import type { ProviderEnv } from "./env.js";
import { ProviderError } from "./result.js";

export type NotifyTarget = "discord" | "telegram";
export const NOTIFY_TARGETS: readonly NotifyTarget[] = ["discord", "telegram"];
export const NOTIFY_HOSTS = { discord: ["discord.com", "discordapp.com"], telegram: ["api.telegram.org"] } as const;

export interface NotifyResult {
  target: NotifyTarget;
  ok: boolean;
  error?: string;
}

/** Discord limits a message to 2000 characters, Telegram to 4096. */
const LIMITS: Record<NotifyTarget, number> = { discord: 2000, telegram: 4096 };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function parseNotifyTargets(value: string): NotifyTarget[] {
  const targets = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const t of targets) if (!(NOTIFY_TARGETS as readonly string[]).includes(t)) throw new Error(`unknown alert target "${t}" (use: ${NOTIFY_TARGETS.join(", ")})`);
  return [...new Set(targets)] as NotifyTarget[];
}

/** What is missing for a target, or null when it is configured. */
export function notifyMissing(env: ProviderEnv, target: NotifyTarget): string | null {
  if (target === "discord") {
    if (!env.DISCORD_WEBHOOK_URL) return "DISCORD_WEBHOOK_URL is not set";
    return discordUrl(env.DISCORD_WEBHOOK_URL) ? null : "DISCORD_WEBHOOK_URL is not a Discord webhook URL (https://discord.com/api/webhooks/…)";
  }
  if (!env.TELEGRAM_BOT_TOKEN) return "TELEGRAM_BOT_TOKEN is not set";
  if (!env.TELEGRAM_CHAT_ID) return "TELEGRAM_CHAT_ID is not set";
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN)) return "TELEGRAM_BOT_TOKEN does not look like a bot token (123456:ABC…)";
  if (!/^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(env.TELEGRAM_CHAT_ID)) return "TELEGRAM_CHAT_ID must be a numeric chat id or @channelname";
  return null;
}

function discordUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (NOTIFY_HOSTS.discord as readonly string[]).includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname) ? u : null;
  } catch {
    return null;
  }
}

export class Notifier {
  constructor(
    private readonly env: ProviderEnv,
    private readonly http: Record<NotifyTarget, HttpClient>,
  ) {}

  /** Sends `text` to every target; never throws — each result says whether delivery worked. */
  async send(text: string, targets: readonly NotifyTarget[]): Promise<NotifyResult[]> {
    return Promise.all(
      targets.map(async (target): Promise<NotifyResult> => {
        const missing = notifyMissing(this.env, target);
        if (missing) return { target, ok: false, error: missing };
        try {
          if (target === "discord") {
            await this.http.discord.text(discordUrl(this.env.DISCORD_WEBHOOK_URL!)!.href, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content: clip(text, LIMITS.discord), allowed_mentions: { parse: [] } }),
            });
          } else {
            const r = await this.http.telegram.json<{ ok?: boolean; description?: string }>(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, text: clip(text, LIMITS.telegram), disable_web_page_preview: true }),
            });
            if (r.body?.ok === false) throw new ProviderError(this.http.telegram.redact(`Telegram: ${r.body.description ?? "not sent"}`), "http");
          }
          return { target, ok: true };
        } catch (error) {
          return { target, ok: false, error: this.http[target].redact(String((error as Error)?.message ?? error)) };
        }
      }),
    );
  }
}
