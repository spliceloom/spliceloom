/**
 * Scheduled delivery of Telegram alerts. Each run reads the chain once (only when someone is
 * subscribed), compares it with the state of the previous run, and sends plain-text messages.
 *
 *   above / below  $SPLICE price crossed a level: sent once, then the alert is removed
 *   whale          a $SPLICE trade at or above the chat's minimum (swap events since the last run)
 *   burn           the burned balance grew
 *   radar          a new pool with at least the chat's minimum liquidity (checked every 10 minutes)
 */
import { describeAlert, tgAmount, tgShort, tgUsd, type AlertRow, type AlertStore } from "./telegram.js";

export interface AlertState {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface AlertDeps {
  store: AlertStore;
  state: AlertState;
  /** Live price, liquidity and recent swaps (see tokenLive). */
  live: () => Promise<Record<string, any>>;
  /** Token summary (burned total). */
  token: () => Promise<Record<string, any>>;
  /** Newest pools with flags (see screener). */
  screener: () => Promise<Record<string, any>>;
  send: (chatId: string, text: string) => Promise<boolean>;
  now?: () => number;
}

const RADAR_EVERY_MS = 10 * 60_000;
/** One run never sends more than this, to stay far below Telegram's limits. */
const MAX_MESSAGES_PER_RUN = 60;
const MAX_RADAR_PER_CHAT = 3;

export async function runTelegramAlerts(deps: AlertDeps): Promise<{ alerts: number; sent: number }> {
  const now = deps.now ?? Date.now;
  const alerts = await deps.store.all();
  if (alerts.length === 0) return { alerts: 0, sent: 0 };
  let sent = 0;
  const send = async (chatId: string, text: string) => {
    if (sent >= MAX_MESSAGES_PER_RUN) return;
    if (await deps.send(chatId, text)) sent++;
  };
  const of = (...kinds: AlertRow["kind"][]) => alerts.filter((a) => kinds.includes(a.kind));

  // ---- price levels and large trades: one read of the pool
  const priceAlerts = of("above", "below");
  const whaleAlerts = of("whale");
  if (priceAlerts.length || whaleAlerts.length) {
    const live = await deps.live().catch(() => null);
    const price = Number(live?.priceUsd);
    if (live?.status === "LIVE" && Number.isFinite(price)) {
      for (const a of priceAlerts) {
        const hit = a.value !== null && (a.kind === "above" ? price >= a.value : price <= a.value);
        if (!hit) continue;
        await send(a.chatId, [`Splice alert: ${describeAlert(a)}.`, `$SPLICE is now ${tgUsd(price)} (pool price, block ${tgAmount(live.block)}).`, "spliceloom.com/token · not financial advice"].join("\n"));
        await deps.store.removeById(a.id);
      }
      if (whaleAlerts.length) {
        // Swaps newer than the last block already reported; the first run only sets the marker.
        const last = (await deps.state.get<number>("tg:whale:block")) ?? null;
        const swaps = ((live.swaps ?? []) as Array<any>).filter((s) => last !== null && s.block > last).reverse();
        for (const s of swaps) {
          for (const a of whaleAlerts) {
            if (!Number.isFinite(Number(s.valueUsd)) || Number(s.valueUsd) < (a.value ?? 0)) continue;
            await send(a.chatId, [`Splice alert: $SPLICE ${s.type === "Buy" ? "BUY" : "SELL"} ${tgUsd(s.valueUsd)}`, `${tgAmount(s.splice)} SPLICE at ${tgUsd(s.priceUsd)} by ${tgShort(s.wallet)}`, `tx ${s.txHash}`, "From the pool's swap events · spliceloom.com/token"].join("\n"));
          }
        }
        await deps.state.set("tg:whale:block", Number(live.block));
      }
    }
  }

  // ---- burns: the burned balance grew
  const burnAlerts = of("burn");
  if (burnAlerts.length) {
    const token = await deps.token().catch(() => null);
    const total = Number(token?.burned?.total);
    if (Number.isFinite(total)) {
      const before = await deps.state.get<number>("tg:burn:total");
      if (before !== null && total > before + 1) {
        for (const a of burnAlerts) await send(a.chatId, ["Splice alert: new $SPLICE burn.", `${tgAmount(total - before)} SPLICE sent to the dead address.`, `Burned in total: ${tgAmount(total)} SPLICE (${Number(token!.burned.pctOfSupply).toFixed(2)}% of supply).`, "spliceloom.com/token"].join("\n"));
      }
      if (before === null || total !== before) await deps.state.set("tg:burn:total", total);
    }
  }

  // ---- radar: new pools, every 10 minutes
  const radarAlerts = of("radar");
  if (radarAlerts.length) {
    const lastRun = (await deps.state.get<number>("tg:radar:at")) ?? 0;
    if (now() - lastRun >= RADAR_EVERY_MS) {
      const data = await deps.screener().catch(() => null);
      const tokens = ((data?.tokens ?? []) as Array<any>).filter((t) => t.address && t.createdAt);
      // Only pools created after the previous check; the first check only sets the marker.
      const fresh = lastRun ? tokens.filter((t) => Date.parse(t.createdAt) > lastRun) : [];
      for (const a of radarAlerts) {
        for (const t of fresh.filter((x) => Number(x.liquidityUsd) >= (a.value ?? 0)).slice(0, MAX_RADAR_PER_CHAT)) {
          await send(a.chatId, [`Splice radar: new token ${t.symbol ?? "?"}`, `Liquidity ${tgUsd(t.liquidityUsd)} · volume ${tgUsd(t.volume24hUsd)}`, `Security: ${(t.flags ?? [{ text: "n/a" }]).map((f: { text: string }) => f.text).join(", ")} (GoPlus)`, String(t.address), "Listed automatically, not reviewed or endorsed. High risk. Not financial advice."].join("\n"));
        }
      }
      if (tokens.length || !lastRun) await deps.state.set("tg:radar:at", now());
    }
  }
  return { alerts: alerts.length, sent };
}
