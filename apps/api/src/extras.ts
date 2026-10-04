/**
 * Keyless public sources next to the chain data: SEC EDGAR filings for the companies behind stock
 * tokens, Polymarket odds on macro and stock events, and GitHub's repository search for the agent
 * directory. Requests go to the hosts listed here only.
 * Titles and descriptions are third-party text: they are passed through as plain strings and never
 * interpreted. A source that fails is reported as unavailable, never filled in.
 */
export type ExternalFetch = (url: string, init?: RequestInit) => Promise<Response>;

const HOSTS = new Set(["data.sec.gov", "www.sec.gov", "gamma-api.polymarket.com", "api.github.com"]);
/** SEC asks automated clients to identify themselves in the User-Agent. */
export const SEC_USER_AGENT = "Splice/1.0 (+https://spliceloom.com)";

async function getJson(fetcher: ExternalFetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  if (!HOSTS.has(new URL(url).hostname)) throw new Error("host not allowed");
  const r = await fetcher(url, { headers: { accept: "application/json", ...headers }, redirect: "manual" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

// ------------------------------------------------------------------------------- SEC filings

/** What the common 8-K item numbers mean (SEC Form 8-K instructions). */
const ITEMS_8K: Record<string, string> = {
  "1.01": "material agreement",
  "1.02": "agreement terminated",
  "1.03": "bankruptcy",
  "2.01": "acquisition or disposal completed",
  "2.02": "results of operations (earnings)",
  "2.03": "new debt obligation",
  "2.05": "restructuring costs",
  "2.06": "material impairment",
  "3.01": "listing notice",
  "3.02": "unregistered share sale",
  "4.01": "auditor change",
  "4.02": "earlier statements not reliable",
  "5.02": "director or officer change",
  "5.03": "bylaw amendment",
  "5.07": "shareholder vote",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
  "9.01": "exhibits",
};
const FORM_LABEL: Record<string, string> = {
  "8-K": "current report",
  "10-Q": "quarterly report",
  "10-K": "annual report",
  "4": "insider transaction",
  "144": "proposed insider sale",
  "DEF 14A": "proxy statement",
  "S-1": "registration statement",
  "6-K": "foreign issuer report",
  "20-F": "annual report (foreign issuer)",
  "SC 13D": "5%+ ownership (active)",
  "SC 13G": "5%+ ownership (passive)",
  "SCHEDULE 13D": "5%+ ownership (active)",
  "SCHEDULE 13G": "5%+ ownership (passive)",
  "424B2": "prospectus",
  "424B3": "prospectus",
  "S-3": "registration statement",
  "S-4": "registration statement (merger or exchange)",
  "S-8": "employee share plan registration",
  EFFECT: "registration declared effective",
  "13F-HR": "institutional holdings report",
  "N-PX": "proxy voting record",
  "DEFA14A": "additional proxy material",
  "ARS": "annual report to shareholders",
  "SD": "specialized disclosure",
  "11-K": "employee plan annual report",
  "424B5": "prospectus",
};

const INSIDER_FORMS = new Set(["3", "4", "5", "144"]);

export const TICKER = /^[A-Z][A-Z.\-]{0,7}$/;

/** Ticker → CIK for every company in SEC's ticker file. */
export async function secTickers(fetcher: ExternalFetch): Promise<Record<string, number>> {
  const raw = (await getJson(fetcher, "https://www.sec.gov/files/company_tickers.json", { "user-agent": SEC_USER_AGENT })) as Record<string, { cik_str?: number; ticker?: string }>;
  const out: Record<string, number> = {};
  for (const row of Object.values(raw)) if (typeof row?.ticker === "string" && Number.isInteger(row.cik_str) && !(row.ticker.toUpperCase() in out)) out[row.ticker.toUpperCase()] = row.cik_str!;
  return out;
}

export interface Filing {
  form: string;
  label: string | null;
  filedAt: string;
  acceptedAt: string | null;
  description: string | null;
  items: string[];
  url: string;
}

/** The latest SEC filings of one filer (EDGAR submissions API). */
export async function secFilings(fetcher: ExternalFetch, symbol: string, cik: number, limit = 12): Promise<Record<string, unknown>> {
  const padded = String(cik).padStart(10, "0");
  const j = (await getJson(fetcher, `https://data.sec.gov/submissions/CIK${padded}.json`, { "user-agent": SEC_USER_AGENT })) as { name?: unknown; filings?: { recent?: Record<string, unknown[]> } };
  const r = j.filings?.recent ?? {};
  const forms = (r.form ?? []) as unknown[];
  const filings: Filing[] = [];
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  let insider30d = 0;
  let insiderLatest: string | null = null;
  for (let i = 0; i < forms.length && i < 400; i++) {
    const form = clean(forms[i], 20);
    const accession = clean(r.accessionNumber?.[i], 25);
    const doc = clean(r.primaryDocument?.[i], 120);
    if (!form || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    // Insider forms (3, 4, 5, 144) arrive in bursts and would bury the company's own filings: counted, not listed.
    if (INSIDER_FORMS.has(form.replace(/\/A$/, ""))) {
      const filed = clean(r.filingDate?.[i], 10);
      insiderLatest ??= filed;
      if (filed >= monthAgo) insider30d++;
      continue;
    }
    if (filings.length >= limit) continue;
    const items = clean(r.items?.[i], 80).split(",").map((s) => s.trim()).filter(Boolean);
    filings.push({
      form,
      label: FORM_LABEL[form.replace(/\/A$/, "")] ?? null,
      filedAt: clean(r.filingDate?.[i], 10),
      acceptedAt: clean(r.acceptanceDateTime?.[i], 30) || null,
      description: clean(r.primaryDocDescription?.[i], 80) || null,
      items: items.map((code) => (ITEMS_8K[code] ? `${code} ${ITEMS_8K[code]}` : code)),
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${/^[\w.\-\/]+$/.test(doc) && !doc.includes("..") ? doc : ""}`,
    });
  }
  return { symbol, cik, company: clean(j.name, 80) || null, filings, insider: { filings30d: insider30d, latest: insiderLatest }, source: "SEC EDGAR", fetchedAt: new Date().toISOString() };
}

// --------------------------------------------------------------------------- prediction markets

interface PolyMarket {
  question?: unknown;
  groupItemTitle?: unknown;
  outcomePrices?: unknown;
  closed?: unknown;
  active?: unknown;
}
interface PolyEvent {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  endDate?: unknown;
  volume24hr?: unknown;
  volume?: unknown;
  markets?: PolyMarket[];
}
export interface OddsEvent {
  id: string;
  title: string;
  endsAt: string | null;
  volume24hUsd: number | null;
  /** "outcomes": mutually exclusive, most likely first. "thresholds": independent levels, the ones nearest 50%. */
  kind: "outcomes" | "thresholds";
  outcomes: Array<{ label: string; probability: number }>;
  url: string;
}

/** Probability of "Yes" for one market (the first outcome price), or null. */
function yesPrice(m: PolyMarket): number | null {
  let prices: unknown = m.outcomePrices;
  if (typeof prices === "string") {
    try {
      prices = JSON.parse(prices);
    } catch {
      return null;
    }
  }
  const p = Array.isArray(prices) ? Number(prices[0]) : NaN;
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

export function oddsEvent(e: PolyEvent, maxOutcomes = 4): OddsEvent | null {
  const title = clean(e.title, 120);
  const slug = clean(e.slug, 120);
  if (!title || !/^[\w\-]+$/.test(slug)) return null;
  const markets = (e.markets ?? []).filter((m) => m.closed !== true && m.active !== false);
  const all = markets
    .map((m) => ({ label: clean(m.groupItemTitle, 40) || (markets.length === 1 ? "Yes" : clean(m.question, 60)), probability: yesPrice(m) }))
    .filter((o): o is { label: string; probability: number } => Boolean(o.label) && o.probability !== null);
  if (!all.length) return null;
  // Outcomes that exclude each other add up to about 1: the most likely ones are the story. Otherwise
  // the markets are independent thresholds ("above $240", "above $250"…), where the ones nearest 50%
  // carry the information.
  const exclusive = all.length === 1 || (!all.some((o) => /^[↑↓]/.test(o.label)) && Math.abs(all.reduce((sum, o) => sum + o.probability, 0) - 1) <= 0.15);
  const outcomes = (exclusive ? [...all].sort((a, b) => b.probability - a.probability) : [...all].sort((a, b) => Math.abs(a.probability - 0.5) - Math.abs(b.probability - 0.5))).slice(0, maxOutcomes);
  if (!exclusive) outcomes.sort((a, b) => b.probability - a.probability);
  const volume = Number(e.volume24hr);
  return { id: String(e.id ?? slug), title, endsAt: clean(e.endDate, 30) || null, volume24hUsd: Number.isFinite(volume) ? volume : null, kind: exclusive ? "outcomes" : "thresholds", outcomes, url: `https://polymarket.com/event/${slug}` };
}

const MACRO_TAGS = ["fed", "inflation"];

/**
 * Open Polymarket events by 24h volume: macro (Fed, inflation) and events that name one of
 * `symbols` as "(TICKER)" in the title. Odds are market prices, not forecasts by Splice.
 */
export async function predictionOdds(fetcher: ExternalFetch, symbols: string[] = []): Promise<Record<string, unknown>> {
  const page = async (tag: string, limit: number) => {
    try {
      const j = await getJson(fetcher, `https://gamma-api.polymarket.com/events?closed=false&limit=${limit}&order=volume24hr&ascending=false&tag_slug=${tag}`);
      return Array.isArray(j) ? (j as PolyEvent[]) : [];
    } catch {
      return null;
    }
  };
  const [stocks, ...macroPages] = await Promise.all([page("stocks", 60), ...MACRO_TAGS.map((t) => page(t, 6))]);
  const seen = new Set<string>();
  const unique = (events: PolyEvent[]) =>
    events
      .map((e) => oddsEvent(e))
      .filter((e): e is OddsEvent => e !== null && !seen.has(e.id) && Boolean(seen.add(e.id)))
      .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  const macro = unique(macroPages.flatMap((p) => p ?? [])).slice(0, 6);
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const stockEvents = unique((stocks ?? []).filter((e) => [...clean(e.title, 120).matchAll(/\(([A-Z.]{1,6})\)/g)].some((m) => wanted.has(m[1]!)))).slice(0, 5);
  const ok = stocks !== null || macroPages.some((p) => p !== null);
  return { macro, stocks: stockEvents, source: { status: ok ? "LIVE" : "UNAVAILABLE", source: "polymarket", fetchedAt: new Date().toISOString() }, note: "Prices of prediction-market contracts (Polymarket), read as probabilities. Not a forecast and not financial advice." };
}

// ------------------------------------------------------------------------------ agent directory

export interface DirectoryRepo {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  pushedAt: string | null;
  topics: string[];
  url: string;
}

/** Categories of the open-source directory: GitHub topic searches, most-starred first. */
export const DIRECTORY_CATEGORIES: Array<{ key: string; label: string; queries: string[] }> = [
  { key: "agents", label: "Agents and frameworks", queries: ["topic:ai-agents stars:>=5000"] },
  { key: "mcp", label: "MCP servers", queries: ["topic:mcp-server stars:>=2000"] },
  { key: "skills", label: "Agent skills", queries: ["topic:agent-skills stars:>=1000", "topic:claude-skills stars:>=1000"] },
  { key: "onchain", label: "Onchain", queries: ["topic:ai-agents topic:web3 stars:>=300", "topic:mcp-server topic:blockchain stars:>=300", "topic:ai-agents topic:crypto stars:>=300"] },
];

const REPO_NAME = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export function directoryRepo(raw: unknown): DirectoryRepo | null {
  const r = (raw ?? {}) as { full_name?: unknown; description?: unknown; stargazers_count?: unknown; language?: unknown; license?: { spdx_id?: unknown } | null; pushed_at?: unknown; topics?: unknown; fork?: unknown; archived?: unknown; private?: unknown };
  const fullName = clean(r.full_name, 201);
  const stars = Number(r.stargazers_count);
  if (!REPO_NAME.test(fullName) || !Number.isFinite(stars) || r.fork === true || r.archived === true || r.private === true) return null;
  const license = clean(r.license?.spdx_id, 30);
  return {
    fullName,
    description: clean(r.description, 200) || null,
    stars,
    language: clean(r.language, 30) || null,
    license: license && license !== "NOASSERTION" ? license : null,
    pushedAt: clean(r.pushed_at, 30) || null,
    topics: Array.isArray(r.topics) ? r.topics.map((t) => clean(t, 40)).filter(Boolean).slice(0, 8) : [],
    // The link is built from the validated owner/name, never taken from the response.
    url: `https://github.com/${fullName}`,
  };
}

/**
 * Open-source agents, MCP servers and skills on GitHub, by topic and stars. Repositories are listed
 * automatically; nothing here is reviewed. `token` (optional) raises GitHub's search rate limit.
 */
export async function agentDirectory(fetcher: ExternalFetch, token?: string, perCategory = 30): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "user-agent": SEC_USER_AGENT, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let failed = 0;
  const categories = [];
  for (const c of DIRECTORY_CATEGORIES) {
    const seen = new Map<string, DirectoryRepo>();
    // One request at a time: GitHub's search API allows few requests per minute.
    for (const q of c.queries) {
      try {
        const j = (await getJson(fetcher, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perCategory}`, headers)) as { items?: unknown[] };
        for (const item of j.items ?? []) {
          const repo = directoryRepo(item);
          if (repo && !seen.has(repo.fullName.toLowerCase())) seen.set(repo.fullName.toLowerCase(), repo);
        }
      } catch {
        failed++;
      }
    }
    categories.push({ key: c.key, label: c.label, repos: [...seen.values()].sort((a, b) => b.stars - a.stars).slice(0, perCategory) });
  }
  const filled = categories.filter((c) => c.repos.length > 0).length;
  return { categories, source: { status: filled === 0 ? "UNAVAILABLE" : failed ? "PARTIAL" : "LIVE", source: "github", fetchedAt: new Date().toISOString() }, note: "Listed automatically from GitHub by topic and stars. Not reviewed or endorsed by Splice." };
}
