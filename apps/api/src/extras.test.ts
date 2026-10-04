import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISCORD_COMMANDS, discordReply, handleDiscordInteraction, verifyDiscordSignature } from "./discord.js";
import { oddsEvent, predictionOdds, secFilings, secTickers, type ExternalFetch } from "./extras.js";
import { telegramReply, type TelegramDeps } from "./telegram.js";

const today = new Date().toISOString().slice(0, 10);
const submissions = {
  name: "EXAMPLE CORP",
  filings: {
    recent: {
      form: ["4", "8-K", "4", "10-Q", "144", "8-K/A"],
      accessionNumber: ["0000000001-26-000001", "0000000001-26-000002", "0000000001-26-000003", "0000000001-26-000004", "0000000001-26-000005", "not-an-accession"],
      filingDate: [today, "2026-08-26", "2020-01-01", "2026-08-20", today, "2026-08-01"],
      acceptanceDateTime: ["", "2026-08-26T20:00:00.000Z", "", "", "", ""],
      primaryDocument: ["xslF345X05/form4.xml", "ex-8k.htm", "form4.xml", "../../evil.htm", "", "a.htm"],
      primaryDocDescription: ["FORM 4", "8-K", "FORM 4", "10-Q", "", "8-K/A"],
      items: ["", "2.02,9.01", "", "", "", ""],
    },
  },
};
const events = [
  { id: "1", slug: "fed-decision", title: "Fed Decision in October?", endDate: "2026-10-28T00:00:00Z", volume24hr: 1000, markets: [
    { groupItemTitle: "No change", outcomePrices: '["0.83", "0.17"]' },
    { groupItemTitle: "25 bps increase", outcomePrices: '["0.16", "0.84"]' },
    { groupItemTitle: "Placeholder", outcomePrices: '["0.5", "0.5"]', active: false },
    { groupItemTitle: "Closed", outcomePrices: '["0.9", "0.1"]', closed: true },
  ] },
  { id: "2", slug: "nvda-hit", title: "What will NVIDIA (NVDA) hit in October?", volume24hr: 500, markets: [
    { groupItemTitle: "↑ $300", outcomePrices: '["0.02", "0.98"]' },
    { groupItemTitle: "↑ $240", outcomePrices: '["0.55", "0.45"]' },
    { groupItemTitle: "↓ $220", outcomePrices: '["0.40", "0.60"]' },
  ] },
  { id: "3", slug: "other-hit", title: "What will Other Co (ZZZ) hit?", volume24hr: 900, markets: [{ question: "Yes?", outcomePrices: '["0.5", "0.5"]' }] },
  { id: "4", slug: "bad slug!", title: "Broken", markets: [{ outcomePrices: '["0.5", "0.5"]' }] },
];
const fetcher: ExternalFetch = async (url) => {
  if (url === "https://www.sec.gov/files/company_tickers.json") return Response.json({ 0: { cik_str: 1234, ticker: "EXM" }, 1: { cik_str: 99, ticker: "exm" } });
  if (url === "https://data.sec.gov/submissions/CIK0000001234.json") return Response.json(submissions);
  if (url.startsWith("https://gamma-api.polymarket.com/events?")) return Response.json(url.includes("tag_slug=stocks") ? events.slice(1) : url.includes("tag_slug=fed") ? events.slice(0, 1) : []);
  return new Response("no", { status: 404 });
};

describe("SEC filings", () => {
  it("maps tickers to CIKs, first listing wins", async () => {
    assert.deepEqual(await secTickers(fetcher), { EXM: 1234 });
  });

  it("lists company filings, counts insider forms, and builds sec.gov links from validated parts only", async () => {
    const f = (await secFilings(fetcher, "EXM", 1234)) as { company: string; filings: Array<{ form: string; items: string[]; url: string; label: string | null }>; insider: { filings30d: number; latest: string } };
    assert.equal(f.company, "EXAMPLE CORP");
    assert.deepEqual(f.filings.map((x) => x.form), ["8-K", "10-Q"]);
    assert.deepEqual(f.filings[0]!.items, ["2.02 results of operations (earnings)", "9.01 exhibits"]);
    assert.equal(f.filings[0]!.url, "https://www.sec.gov/Archives/edgar/data/1234/000000000126000002/ex-8k.htm");
    // A document path that climbs out of the filing folder is dropped.
    assert.equal(f.filings[1]!.url, "https://www.sec.gov/Archives/edgar/data/1234/000000000126000004/");
    assert.deepEqual(f.insider, { filings30d: 2, latest: today });
  });

  it("refuses hosts outside its list", async () => {
    await assert.rejects(secFilings(async () => Response.json({}), "X", 1).then(() => predictionOdds(async () => Response.json([]), [])).then(() => secTickers((url) => fetcher(url.replace("www.sec.gov", "evil.example")))), /./);
  });
});

describe("prediction markets", () => {
  it("shows the most likely outcomes of exclusive events and skips placeholder and closed markets", () => {
    const e = oddsEvent(events[0]!)!;
    assert.equal(e.kind, "outcomes");
    assert.deepEqual(e.outcomes, [{ label: "No change", probability: 0.83 }, { label: "25 bps increase", probability: 0.16 }]);
    assert.equal(e.url, "https://polymarket.com/event/fed-decision");
  });

  it("shows the levels nearest 50% for threshold events", () => {
    const e = oddsEvent(events[1]!, 2)!;
    assert.equal(e.kind, "thresholds");
    assert.deepEqual(e.outcomes.map((o) => o.label), ["↑ $240", "↓ $220"]);
  });

  it("drops events it cannot link safely and keeps only stock events naming a listed ticker", async () => {
    assert.equal(oddsEvent(events[3]!), null);
    const o = (await predictionOdds(fetcher, ["NVDA"])) as { macro: Array<{ title: string }>; stocks: Array<{ title: string }>; source: { status: string } };
    assert.deepEqual(o.macro.map((e) => e.title), ["Fed Decision in October?"]);
    assert.deepEqual(o.stocks.map((e) => e.title), ["What will NVIDIA (NVDA) hit in October?"]);
    assert.equal(o.source.status, "LIVE");
    const down = (await predictionOdds(async () => new Response("x", { status: 500 }), [])) as { source: { status: string } };
    assert.equal(down.source.status, "UNAVAILABLE");
  });
});

const deps = {
  token: async () => ({ address: "0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806", burned: { total: 10, pctOfSupply: 1 } }),
  filings: async (symbol: string) => (symbol === "EXM" ? secFilings(fetcher, "EXM", 1234) : null),
  odds: async () => predictionOdds(fetcher, ["NVDA"]),
} as unknown as TelegramDeps;

describe("bot: filings and odds", () => {
  it("answers /filings and /odds, and says when SEC has no filer", async () => {
    const f = await telegramReply("/filings exm", "1", deps, "Alex");
    assert.match(f!, /Alex, the latest SEC filings of EXAMPLE CORP \(EXM\):\n2026-08-26 {2}8-K {2}current report: 2\.02 results of operations \(earnings\)\n/);
    assert.match(f!, /Insider forms \(3, 4, 5, 144\) in the last 30 days: 2/);
    assert.equal(await telegramReply("/filings NOPE", "1", deps, "Alex"), "Alex, SEC lists no filer for NOPE.");
    assert.match((await telegramReply("/filings", "1", deps, "Alex"))!, /use it like this/);
    assert.match((await telegramReply("/odds", "1", deps, "Alex"))!, /Fed Decision in October\?\nNo change 83% · 25 bps increase 16%/);
  });
});

describe("discord bot", () => {
  const sign = async (body: string, timestamp: string) => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { publicKey: Parameters<typeof crypto.subtle.sign>[1]; privateKey: Parameters<typeof crypto.subtle.sign>[1] };
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    return { key: hex(await crypto.subtle.exportKey("raw", pair.publicKey)), signature: hex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(timestamp + body))) };
  };

  it("accepts only requests signed by the application's key", async () => {
    const s = await sign("{}", "100");
    assert.equal(await verifyDiscordSignature(s.key, s.signature, "100", "{}"), true);
    assert.equal(await verifyDiscordSignature(s.key, s.signature, "101", "{}"), false);
    assert.equal(await verifyDiscordSignature(s.key, s.signature, "100", "{ }"), false);
    assert.equal(await verifyDiscordSignature(s.key, null, "100", "{}"), false);
    assert.equal(await verifyDiscordSignature("zz", s.signature, "100", "{}"), false);
  });

  it("answers pings and commands, greets by name, and never pings anyone", async () => {
    assert.deepEqual(await handleDiscordInteraction({ type: 1 }, deps), { type: 1 });
    const r = (await handleDiscordInteraction({ type: 2, data: { name: "filings", options: [{ value: "EXM" }] }, channel_id: "5", member: { user: { global_name: "Alex" } } }, deps)) as { type: number; data: { content: string; allowed_mentions: unknown } };
    assert.equal(r.type, 4);
    assert.match(r.data.content, /^Alex, the latest SEC filings of EXAMPLE CORP/);
    assert.deepEqual(r.data.allowed_mentions, { parse: [] });
  });

  it("defers when it can reply in the background and edits the original message", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const tasks: Promise<unknown>[] = [];
    const r = await handleDiscordInteraction(
      { type: 2, application_id: "123456789012345678", token: "a".repeat(40), data: { name: "ca" }, user: { username: "alex" } },
      deps,
      { background: (t) => void tasks.push(t), fetch: async (url, init) => (calls.push({ url, body: String(init?.body) }), new Response("{}")) },
    );
    assert.deepEqual(r, { type: 5 });
    await Promise.all(tasks);
    assert.equal(calls[0]!.url, `https://discord.com/api/v10/webhooks/123456789012345678/${"a".repeat(40)}/messages/@original`);
    assert.match(JSON.parse(calls[0]!.body).content, /0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806/);
  });

  it("points alert hints at Telegram and lists no alert commands", async () => {
    assert.match(await discordReply("burned", "", "5", deps, "Alex"), /every new burn: t\.me\/spliceloombot/);
    const help = await discordReply("help", "", "5", deps, "Alex");
    assert.match(help, /\/filings NVDA/);
    assert.doesNotMatch(help, /\/whales|\/alertoff/);
    assert.equal(DISCORD_COMMANDS.some((c) => ["alert", "whales", "burns", "radar"].includes(c.name)), false);
    assert.equal(await discordReply("whales", "on", "5", deps, "Alex"), "Unknown command. See /help.");
  });
});

describe("agent directory", () => {
  const item = (over: Record<string, unknown>) => ({ full_name: "acme/agent", description: "An agent", stargazers_count: 10, language: "TypeScript", license: { spdx_id: "MIT" }, pushed_at: "2026-10-01T00:00:00Z", topics: ["ai-agents"], ...over });

  it("keeps public, original, maintained repositories and builds the link from the validated name", async () => {
    const { directoryRepo } = await import("./extras.js");
    assert.deepEqual(directoryRepo(item({})), { fullName: "acme/agent", description: "An agent", stars: 10, language: "TypeScript", license: "MIT", pushedAt: "2026-10-01T00:00:00Z", topics: ["ai-agents"], url: "https://github.com/acme/agent" });
    assert.equal(directoryRepo(item({ fork: true })), null);
    assert.equal(directoryRepo(item({ archived: true })), null);
    assert.equal(directoryRepo(item({ full_name: "acme/agent\" onclick=\"x" })), null);
    assert.equal(directoryRepo(item({ full_name: "https://evil.example/a/b" })), null);
    assert.equal(directoryRepo(item({ license: { spdx_id: "NOASSERTION" } }))!.license, null);
  });

  it("merges a category's searches, most-starred first, and reports partial results", async () => {
    const { agentDirectory, DIRECTORY_CATEGORIES } = await import("./extras.js");
    const seen: string[] = [];
    const fetcher: ExternalFetch = async (url, init) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      seen.push(q);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer t");
      if (q.includes("claude-skills")) return new Response("limited", { status: 403 });
      if (q.includes("agent-skills")) return Response.json({ items: [item({ full_name: "a/small", stargazers_count: 5 }), item({ full_name: "a/big", stargazers_count: 50 }), item({ full_name: "A/BIG", stargazers_count: 50 })] });
      return Response.json({ items: [item({})] });
    };
    const d = (await agentDirectory(fetcher, "t")) as { categories: Array<{ key: string; repos: Array<{ fullName: string }> }>; source: { status: string } };
    assert.equal(seen.length, DIRECTORY_CATEGORIES.reduce((n, c) => n + c.queries.length, 0));
    assert.deepEqual(d.categories.find((c) => c.key === "skills")!.repos.map((r) => r.fullName), ["a/big", "a/small"]);
    assert.equal(d.source.status, "PARTIAL");
    const down = (await agentDirectory(async () => new Response("x", { status: 500 }))) as { source: { status: string } };
    assert.equal(down.source.status, "UNAVAILABLE");
  });
});
