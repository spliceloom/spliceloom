/**
 * Cloudflare Worker adapter for the public API (api.spliceloom.com).
 *
 * Provider keys are Worker secrets, read only through the PROVIDER_ENV whitelist. Requests to
 * providers use the platform fetch, limited to each provider's hosts (@spliceloom/data hostLockedFetch).
 * GET responses are cached at the edge; Ask is limited per client (burst binding + daily D1 counter)
 * and globally per day.
 */
import { PROVIDER_ENV, SpliceData } from "@spliceloom/data";
import { apiSources, createApiHandler, type Counters, type JsonCache } from "./handler.js";
import { runTelegramAlerts, type AlertState } from "./telegram-alerts.js";
import type { AlertKind, AlertRow, AlertStore } from "./telegram.js";

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta?: { changes?: number } }> };
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
}

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB?: D1Like;
  ASK_LIMITER?: RateLimitBinding;
  ALLOWED_ORIGINS?: string;
  ASK_DAILY_LIMIT?: string;
  ASK_PER_CLIENT_DAILY?: string;
  [key: string]: unknown;
}

const DEFAULT_ORIGINS = ["https://spliceloom.com", "https://www.spliceloom.com", "https://docs.spliceloom.com"];

function d1Counters(db: D1Like): Counters {
  let ready: Promise<unknown> | undefined;
  return {
    async increment(key, expiresAt) {
      ready ??= db.prepare("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, expires INTEGER NOT NULL)").run();
      await ready;
      const row = await db
        .prepare("INSERT INTO counters (k, n, expires) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n")
        .bind(key, expiresAt)
        .first<{ n: number }>();
      return row?.n ?? 1;
    },
  };
}

function d1Cache(db: D1Like): JsonCache {
  let ready: Promise<unknown> | undefined;
  const init = () => (ready ??= db.prepare("CREATE TABLE IF NOT EXISTS json_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)").run());
  return {
    async get(key) {
      await init();
      const row = await db.prepare("SELECT v, at FROM json_cache WHERE k = ?1").bind(key).first<{ v: string; at: number }>();
      return row ? { value: JSON.parse(row.v), at: row.at } : null;
    },
    async set(key, value, at) {
      await init();
      await db.prepare("INSERT INTO json_cache (k, v, at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(key, JSON.stringify(value), at).run();
    },
  };
}

/** Telegram alert subscriptions. whale / burn / radar are one per chat. */
function d1Alerts(db: D1Like): AlertStore {
  let ready: Promise<unknown> | undefined;
  const init = () => (ready ??= db.prepare("CREATE TABLE IF NOT EXISTS tg_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, kind TEXT NOT NULL, value REAL, created INTEGER NOT NULL)").run());
  const row = (r: { id: number; chat: string; kind: string; value: number | null }): AlertRow => ({ id: r.id, chatId: r.chat, kind: r.kind as AlertKind, value: r.value });
  return {
    async add(chatId, kind, value) {
      await init();
      if (kind === "whale" || kind === "burn" || kind === "radar") await db.prepare("DELETE FROM tg_alerts WHERE chat = ?1 AND kind = ?2").bind(chatId, kind).run();
      await db.prepare("INSERT INTO tg_alerts (chat, kind, value, created) VALUES (?1, ?2, ?3, ?4)").bind(chatId, kind, value, Date.now()).run();
    },
    async list(chatId) {
      await init();
      return (await db.prepare("SELECT id, chat, kind, value FROM tg_alerts WHERE chat = ?1 ORDER BY id").bind(chatId).all<{ id: number; chat: string; kind: string; value: number | null }>()).results.map(row);
    },
    async remove(chatId, which) {
      await init();
      const r =
        which === "all"
          ? await db.prepare("DELETE FROM tg_alerts WHERE chat = ?1").bind(chatId).run()
          : typeof which === "number"
            ? await db.prepare("DELETE FROM tg_alerts WHERE chat = ?1 AND id = ?2").bind(chatId, which).run()
            : await db.prepare("DELETE FROM tg_alerts WHERE chat = ?1 AND kind = ?2").bind(chatId, which).run();
      return r.meta?.changes ?? 0;
    },
    async all() {
      await init();
      return (await db.prepare("SELECT id, chat, kind, value FROM tg_alerts ORDER BY id LIMIT 2000").all<{ id: number; chat: string; kind: string; value: number | null }>()).results.map(row);
    },
    async removeById(id) {
      await init();
      await db.prepare("DELETE FROM tg_alerts WHERE id = ?1").bind(id).run();
    },
  };
}

const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const providerEnv: Record<string, string> = {};
    for (const name of PROVIDER_ENV) if (typeof env[name] === "string") providerEnv[name] = env[name] as string;
    const options: Parameters<typeof createApiHandler>[0] = {
      data: () => new SpliceData({ env: providerEnv, envFile: null, platformFetch: (input, init) => fetch(input, init) }),
      fetch: (url, init) => fetch(url, init),
      origins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS,
    };
    options.background = (task) => ctx.waitUntil(task);
    if (env.DB) {
      options.counters = d1Counters(env.DB);
      options.cache = d1Cache(env.DB);
      options.alerts = d1Alerts(env.DB);
      // Expired counters are dropped occasionally (no cron needed).
      if (Math.random() < 0.01) ctx.waitUntil(env.DB.prepare("DELETE FROM counters WHERE expires < ?1").bind(Date.now()).run().catch(() => undefined));
    }
    const limiter = env.ASK_LIMITER;
    if (limiter) options.burst = async (client) => (await limiter.limit({ key: client })).success;
    const daily = positive(env.ASK_DAILY_LIMIT);
    if (daily) options.askDailyLimit = daily;
    const perClient = positive(env.ASK_PER_CLIENT_DAILY);
    if (perClient) options.askPerClientDaily = perClient;
    if (typeof env.AI_ASK_MODEL === "string") options.askModel = env.AI_ASK_MODEL;
    if (typeof env.HOLDER_SECRET === "string" && env.HOLDER_SECRET.length >= 32) options.holderSecret = env.HOLDER_SECRET;
    if (typeof env.TELEGRAM_WEBHOOK_SECRET === "string" && env.TELEGRAM_WEBHOOK_SECRET.length >= 16) options.telegramSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (typeof env.DISCORD_PUBLIC_KEY === "string" && /^[0-9a-f]{64}$/i.test(env.DISCORD_PUBLIC_KEY)) options.discordPublicKey = env.DISCORD_PUBLIC_KEY;
    const handle = createApiHandler(options);
    const client = request.headers.get("cf-connecting-ip") ?? "unknown";

    // Edge cache for public GETs (keyed by URL only; the Origin header only changes CORS).
    const cacheable = request.method === "GET" && ["/v1/chain", "/v1/token", "/v1/token/live", "/v1/stocks", "/v1/screener", "/v1/odds"].includes(new URL(request.url).pathname);
    if (!cacheable) return handle(request, client);
    const cache = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    if (!cache) return handle(request, client);
    const key = new Request(new URL(request.url).origin + new URL(request.url).pathname);
    let response = await cache.match(key);
    if (!response) {
      response = await handle(new Request(request.url, { method: "GET" }), client);
      if (response.ok) ctx.waitUntil(cache.put(key, response.clone()));
    }
    const out = new Response(response.body, response);
    const origin = request.headers.get("origin");
    out.headers.delete("access-control-allow-origin");
    if (origin && options.origins.includes(origin)) out.headers.set("access-control-allow-origin", origin);
    out.headers.set("vary", "Origin");
    return out;
  },

  /** Every 2 minutes: deliver Telegram alerts (does nothing while nobody is subscribed). */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!env.DB || typeof botToken !== "string") return;
    const providerEnv: Record<string, string> = {};
    for (const name of PROVIDER_ENV) if (typeof env[name] === "string") providerEnv[name] = env[name] as string;
    const cache = d1Cache(env.DB);
    const sources = apiSources({ data: () => new SpliceData({ env: providerEnv, envFile: null, platformFetch: (input, init) => fetch(input, init) }), cache, background: (task) => ctx.waitUntil(task) });
    const state: AlertState = {
      get: async <T>(key: string) => ((await cache.get(key))?.value as T | undefined) ?? null,
      set: (key, value) => cache.set(key, value, Date.now()),
    };
    const send = async (chatId: string, text: string) => {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }) });
      return r.ok;
    };
    await runTelegramAlerts({ store: d1Alerts(env.DB), state, live: sources.live, token: sources.token, screener: sources.screener, send });
  },
};
