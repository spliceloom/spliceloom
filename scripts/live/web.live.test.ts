/**
 * Live integration tests for the web providers (Tavily, Exa, Firecrawl): real requests with the
 * configured keys. Pages to extract, map or compare are taken from live search results — nothing
 * is hardcoded. Each provider is also asked directly (pinned) so every one is proven separately.
 * These calls spend a few provider credits (Exa reports cost per call).
 *
 *   npm run test:live
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SpliceData, isLive, loadProviderEnv } from "../../packages/data/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = loadProviderEnv({ cwd: ROOT });
const data = new SpliceData({ cwd: ROOT });
const seen: unknown[] = [];
const summary: string[] = [];
const note = (s: string) => summary.push(s);
const live = (r: any, label: string) => {
  seen.push(r);
  assert.ok(isLive(r), `${label}: ${r.status} ${r.code ?? ""} ${r.message ?? r.reason ?? ""} ${JSON.stringify(r.attempts ?? r.providers ?? [])}`);
  return r;
};
const usage = (u: { credits?: number; costUsd?: number } | undefined) => (u ? (u.costUsd !== undefined ? `cost ${u.costUsd} USD` : `${u.credits} credits`) : "usage not reported");

after(() => {
  const text = JSON.stringify(seen);
  for (const secret of env.secrets) assert.ok(!text.includes(secret), "a provider secret leaked into a result");
  console.log(`\nLIVE SUMMARY (web)\n${summary.map((s) => `  ${s}`).join("\n")}\n`);
});

describe("web providers (live)", { timeout: 300_000 }, () => {
  const configured = (name: string) => Boolean(env.values[name as keyof typeof env.values]);
  let target = "";

  it("health checks spend no credits", async () => {
    const rows = await data.providers.check();
    seen.push(rows);
    for (const name of ["tavily", "exa", "firecrawl"]) {
      const r = rows.find((x) => x.provider === name)!;
      note(`health ${name}: ${r.status} — ${r.detail ?? r.lastError}`);
      if (r.configured) assert.equal(r.status, "healthy", `${name}: ${r.lastError}`);
    }
  });

  for (const provider of ["tavily", "exa", "firecrawl"]) {
    it(`${provider}: search returns real results`, { skip: !configured(`${provider.toUpperCase()}_API_KEY`) && "key not set" }, async () => {
      const r = live(await data.web.search("Robinhood Chain Arbitrum Orbit layer 2 documentation", { provider, limit: 3, fresh: true }), `${provider} search`);
      assert.equal(r.provenance.source, provider);
      assert.ok(r.data.results.length > 0 && r.data.results.every((x: { url: string }) => /^https?:\/\//.test(x.url)));
      if (!target) target = r.data.results.find((x: { url: string }) => !/\.pdf($|\?)/i.test(x.url))?.url ?? r.data.results[0].url;
      note(`${provider} search: ${r.data.results.length} results, first ${r.data.results[0].url}; ${usage(r.data.usage)}`);
    });
  }

  for (const provider of ["tavily", "firecrawl", "exa"]) {
    it(`${provider}: extracts a page found by search`, { skip: !configured(`${provider.toUpperCase()}_API_KEY`) && "key not set" }, async () => {
      assert.ok(target, "a URL from the search step");
      const r = live(await data.web.extract(target, { provider, maxCharacters: 2000, fresh: true }), `${provider} extract`);
      const page = r.data.pages[0];
      assert.ok(page?.content && page.content.length > 50, `${provider} returned page text`);
      note(`${provider} extract ${target}: ${page.content.length} chars${page.truncated ? " (truncated)" : ""}; failed=${r.data.failed.length}; ${usage(r.data.usage)}`);
    });
  }

  it("firecrawl and tavily: map the site of that page", async () => {
    const origin = new URL(target).origin;
    for (const provider of ["firecrawl", "tavily"]) {
      if (!configured(`${provider.toUpperCase()}_API_KEY`)) continue;
      const r = live(await data.web.map(origin, { provider, limit: 10, fresh: true }), `${provider} map`);
      assert.ok(r.data.links.length > 0);
      note(`${provider} map ${origin}: ${r.data.links.length} links`);
    }
  });

  it("exa: similar pages", { skip: !configured("EXA_API_KEY") && "key not set" }, async () => {
    const r = live(await data.web.similar(target, { limit: 3, fresh: true }), "exa similar");
    assert.ok(r.data.results.length > 0);
    note(`exa similar: ${r.data.results.length} results; ${usage(r.data.usage)}`);
  });

  for (const provider of ["tavily", "exa"]) {
    it(`${provider}: answer with citations`, { skip: !configured(`${provider.toUpperCase()}_API_KEY`) && "key not set" }, async () => {
      const r = live(await data.web.answer("What is the chain ID of Robinhood Chain mainnet?", { provider, fresh: true }), `${provider} answer`);
      assert.ok(r.data.answer.length > 0 && r.data.citations.length > 0);
      note(`${provider} answer: "${r.data.answer.slice(0, 100)}" (${r.data.citations.length} citations); ${usage(r.data.usage)}`);
    });
  }

  it("default routing and the URL guard", async () => {
    const r = live(await data.web.search("Robinhood Chain chain id", { limit: 2 }), "web search (default order)");
    note(`default web search served by ${r.provenance.source}`);
    const blocked = await data.web.extract("http://169.254.169.254/latest/meta-data/");
    assert.equal(blocked.status === "ERROR" && blocked.code, "INVALID_INPUT");
  });
});
