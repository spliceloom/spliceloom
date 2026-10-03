import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpClient, type FetchLike } from "./http.js";
import { NOTIFY_HOSTS, Notifier, notifyMissing, parseNotifyTargets } from "./notify.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFGH-123";
const BOT = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";

function setup(env: Record<string, string>, respond: (url: string, body: unknown) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, body });
    return respond(url, body);
  };
  const secrets = Object.values(env).filter((v) => v.length > 12);
  const http = (hosts: readonly string[]) => new HttpClient({ hosts: [...hosts], secrets: [...secrets, "abcdefghijklmnopqrstuvwxyz_ABCDEFGH-123"], fetch });
  return { calls, notifier: new Notifier(env, { discord: http(NOTIFY_HOSTS.discord), telegram: http(NOTIFY_HOSTS.telegram) }) };
}

describe("alert delivery", () => {
  it("parses targets and rejects unknown ones", () => {
    assert.deepEqual(parseNotifyTargets("discord, telegram,discord"), ["discord", "telegram"]);
    assert.throws(() => parseNotifyTargets("slack"), /unknown alert target/);
  });

  it("explains what is missing or malformed", () => {
    assert.match(notifyMissing({}, "discord")!, /DISCORD_WEBHOOK_URL is not set/);
    assert.match(notifyMissing({ DISCORD_WEBHOOK_URL: "https://evil.example/api/webhooks/1/x" }, "discord")!, /not a Discord webhook/);
    assert.equal(notifyMissing({ DISCORD_WEBHOOK_URL: WEBHOOK }, "discord"), null);
    assert.match(notifyMissing({ TELEGRAM_BOT_TOKEN: BOT }, "telegram")!, /TELEGRAM_CHAT_ID/);
    assert.equal(notifyMissing({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "-1001234567890" }, "telegram"), null);
  });

  it("posts to Discord and Telegram without mentions or link previews", async () => {
    const { calls, notifier } = setup({ DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "42" }, (url) => (url.includes("telegram") ? Response.json({ ok: true }) : new Response(null, { status: 204 })));
    const results = await notifier.send("Splice alert · TEST", ["discord", "telegram"]);
    assert.deepEqual(results, [{ target: "discord", ok: true }, { target: "telegram", ok: true }]);
    assert.equal(calls[0]!.url, WEBHOOK);
    assert.deepEqual(calls[0]!.body, { content: "Splice alert · TEST", allowed_mentions: { parse: [] } });
    assert.equal(calls[1]!.url, `https://api.telegram.org/bot${BOT}/sendMessage`);
    assert.deepEqual(calls[1]!.body, { chat_id: "42", text: "Splice alert · TEST", disable_web_page_preview: true });
  });

  it("clips long messages to each service's limit", async () => {
    const { calls, notifier } = setup({ DISCORD_WEBHOOK_URL: WEBHOOK }, () => new Response(null, { status: 204 }));
    await notifier.send("x".repeat(5000), ["discord"]);
    assert.equal(calls[0]!.body.content.length, 2000);
  });

  it("reports failures without throwing and without leaking credentials", async () => {
    const { notifier } = setup({ DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "42" }, (url) =>
      url.includes("telegram") ? Response.json({ ok: false, description: `Unauthorized for ${BOT}` }, { status: 401 }) : new Response(`bad webhook ${WEBHOOK}`, { status: 404 }),
    );
    const results = await notifier.send("hi", ["discord", "telegram"]);
    assert.ok(results.every((r) => !r.ok && r.error));
    for (const r of results) {
      assert.ok(!r.error!.includes(BOT), r.error);
      assert.ok(!r.error!.includes("abcdefghijklmnopqrstuvwxyz_ABCDEFGH-123"), r.error);
    }
    const missing = await notifier.send("hi", []);
    assert.deepEqual(missing, []);
  });
});
