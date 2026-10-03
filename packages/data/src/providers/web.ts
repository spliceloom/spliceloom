/**
 * Web search and page extraction: Tavily, Exa and Firecrawl (hosted APIs).
 *
 * Splice only talks to the provider APIs (api.tavily.com, api.exa.ai, api.firecrawl.dev) through
 * the network guard; the providers fetch the web on their side. Target URLs are still validated
 * with the runtime's own rule (http/https, public hosts only — no localhost, private or metadata
 * addresses, no credentials) so a provider is never asked to fetch an internal address.
 * Results are the providers' own (titles, snippets, page text, answers with citations, usage /
 * cost); web content is untrusted third-party text. Health checks never spend credits.
 */
import { checkNetworkTarget } from "@spliceloom/runtime/net-policy";
import type { Scope } from "../chains.js";
import type { HttpClient } from "../http.js";
import type { ProviderCapability, ProviderData, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

type Raw = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export interface WebResult {
  url: string;
  title?: string;
  snippet?: string;
  /** Page text (markdown or plain), when requested; may be truncated (see `truncated`). */
  content?: string;
  truncated?: boolean;
  publishedAt?: string;
  author?: string;
  score?: number;
}

export interface WebPage {
  url: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  statusCode?: number;
}

export interface WebUsage {
  credits?: number;
  costUsd?: number;
}

export interface WebSearchOptions {
  limit: number;
  /** Include page text in results (more credits on some providers). */
  content: boolean;
  maxCharacters: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface WebSource {
  search?(query: string, o: WebSearchOptions): Promise<ProviderData<{ query: string; answer?: string; results: WebResult[]; usage?: WebUsage }>>;
  extract?(urls: string[], maxCharacters: number): Promise<ProviderData<{ pages: WebPage[]; failed: Array<{ url: string; error: string }>; usage?: WebUsage }>>;
  map?(url: string, limit: number): Promise<ProviderData<{ url: string; links: Array<{ url: string; title?: string }>; usage?: WebUsage }>>;
  similar?(url: string, o: WebSearchOptions): Promise<ProviderData<{ url: string; results: WebResult[]; usage?: WebUsage }>>;
  answer?(query: string): Promise<ProviderData<{ query: string; answer: string; citations: Array<{ url: string; title?: string }>; usage?: WebUsage }>>;
}

/**
 * A URL a provider may be asked to fetch: http(s), public host (same rule as skills with
 * network ["*"]: no localhost, private, link-local or metadata addresses), no credentials.
 */
export function checkWebUrl(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) return "URL must be 1–2048 characters";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return `not a valid URL: ${input}`;
  }
  if (url.username || url.password) return "URLs with credentials are not allowed";
  const decision = checkNetworkTarget(url, ["*"]);
  if (!decision.allowed) return `not a public web URL: ${decision.reason}`;
  if (/(^|\.)(local|internal|localhost|home\.arpa)$/i.test(url.hostname)) return `not a public host: ${url.hostname}`;
  return null;
}

function cut(text: string | undefined, max: number): { content?: string; truncated?: boolean } {
  if (text === undefined) return {};
  return text.length > max ? { content: text.slice(0, max), truncated: true } : { content: text };
}

function apiError(provider: string, status: number, headers: Headers, detail: string, extra: Record<number, ProviderError["kind"]> = {}): ProviderError {
  let message = detail;
  try {
    const b = JSON.parse(detail) as Raw;
    message = str(b.error) ?? str(b.detail?.error) ?? str(b.message) ?? str(b.detail) ?? detail;
  } catch {
    /* raw */
  }
  const text = `${provider} HTTP ${status}: ${message}`;
  if (extra[status]) return new ProviderError(text, extra[status]!, status);
  if (status === 401 || status === 403) return new ProviderError(text, "auth", status);
  if (status === 429) {
    const retry = Number(headers.get("retry-after") ?? "NaN");
    return new ProviderError(text, "rate_limited", status, Number.isFinite(retry) ? retry : undefined);
  }
  if (status === 400 || status === 422) return new ProviderError(text, "rejected", status);
  return new ProviderError(text, "http", status);
}

// ---------------------------------------------------------------------------------------- Tavily

const TAVILY = "https://api.tavily.com";

export class TavilyProvider implements WebSource {
  readonly name = "tavily";
  readonly kind: ProviderKind = "web";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["web.search", "web.extract", "web.map", "web.answer"];
  readonly auth = "Bearer API key (TAVILY_API_KEY)";
  readonly envVars = ["TAVILY_API_KEY"];
  readonly endpoint = TAVILY;
  readonly rateLimit = "Plan credits per month (search 1–2, extract 1 per 5 URLs, map 1 per 10 pages); HTTP 429 / 432 when exceeded";
  readonly docs = "https://docs.tavily.com/documentation/api-reference/introduction";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "TAVILY_API_KEY is not set";
  }

  private async post<T = Raw>(path: string, body: Record<string, unknown>): Promise<{ body: T; resource: string }> {
    const res = await this.http.json<T>(
      `${TAVILY}${path}`,
      { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) },
      // 432/433: plan or pay-as-you-go limit exceeded — a provider-side limit, reported as such.
      { timeoutMs: 60_000, mapError: (s, h, d) => apiError("Tavily", s, h, d, { 432: "rate_limited", 433: "rate_limited" }) },
    );
    return { body: res.body, resource: path.slice(1) };
  }

  private usage(b: Raw): WebUsage | undefined {
    const credits = num(b.usage?.credits);
    return credits === undefined ? undefined : { credits };
  }

  private meta<T>(data: T, r: { body: Raw; resource: string }): ProviderData<T> {
    const out: ProviderData<T> = { data, resource: r.resource };
    if (str(r.body.request_id)) out.requestId = r.body.request_id;
    return out;
  }

  async search(query: string, o: WebSearchOptions) {
    const r = await this.post("/search", prune({ query, max_results: o.limit, search_depth: "basic", include_answer: false, include_raw_content: o.content ? "markdown" : false, include_domains: o.includeDomains, exclude_domains: o.excludeDomains, include_usage: true }));
    const results = (r.body.results ?? []).map((x: Raw) => prune({ url: String(x.url), title: str(x.title), snippet: str(x.content), ...(o.content ? cut(str(x.raw_content), o.maxCharacters) : {}), publishedAt: str(x.published_date), score: num(x.score) }) as WebResult);
    return this.meta(prune({ query, results, usage: this.usage(r.body) }), r);
  }

  async answer(query: string) {
    const r = await this.post("/search", { query, max_results: 5, search_depth: "basic", include_answer: "basic", include_usage: true });
    const answer = str(r.body.answer);
    if (!answer) throw new ProviderError("Tavily returned no answer for this query", "not_listed");
    const citations = (r.body.results ?? []).map((x: Raw) => prune({ url: String(x.url), title: str(x.title) }));
    return this.meta(prune({ query, answer, citations, usage: this.usage(r.body) }), r);
  }

  async extract(urls: string[], maxCharacters: number) {
    const r = await this.post("/extract", { urls, format: "markdown", include_usage: true });
    const pages = (r.body.results ?? []).map((x: Raw) => prune({ url: String(x.url), title: str(x.title), ...cut(str(x.raw_content), maxCharacters) }) as WebPage);
    const failed = (r.body.failed_results ?? []).map((x: Raw) => ({ url: String(x.url), error: String(x.error ?? "failed") }));
    return this.meta(prune({ pages, failed, usage: this.usage(r.body) }), r);
  }

  async map(url: string, limit: number) {
    const r = await this.post("/map", { url, limit, include_usage: true });
    const links = ((r.body.results ?? []) as unknown[]).slice(0, limit).map((u) => ({ url: String(u) }));
    return this.meta(prune({ url, links, usage: this.usage(r.body) }), r);
  }

  /** Free: key usage endpoint (spends no credits). */
  async check(_scope: Scope): Promise<{ detail: string }> {
    const res = await this.http.json<Raw>(`${TAVILY}/usage`, { headers: { authorization: `Bearer ${this.apiKey}` } }, { mapError: (s, h, d) => apiError("Tavily", s, h, d) });
    const a = res.body.account ?? {};
    return { detail: `key accepted; plan ${a.current_plan ?? "?"}, ${a.plan_usage ?? "?"}/${a.plan_limit ?? "?"} credits used this period` };
  }
}

// ------------------------------------------------------------------------------------------- Exa

const EXA = "https://api.exa.ai";

export class ExaProvider implements WebSource {
  readonly name = "exa";
  readonly kind: ProviderKind = "web";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["web.search", "web.extract", "web.similar", "web.answer"];
  readonly auth = "API key header x-api-key (EXA_API_KEY)";
  readonly envVars = ["EXA_API_KEY"];
  readonly endpoint = EXA;
  readonly rateLimit = "Pay per request (cost reported per response); HTTP 402 without credits, 429 when rate limited";
  readonly docs = "https://docs.exa.ai/reference/getting-started";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "EXA_API_KEY is not set";
  }

  private async post<T = Raw>(path: string, body: Record<string, unknown>): Promise<{ body: T; headers: Headers; resource: string }> {
    const res = await this.http.json<T>(`${EXA}${path}`, { method: "POST", headers: { "x-api-key": this.apiKey ?? "", "content-type": "application/json" }, body: JSON.stringify(body) }, { timeoutMs: 60_000, mapError: (s, h, d) => apiError("Exa", s, h, d) });
    return { body: res.body, headers: res.headers, resource: path.slice(1) };
  }

  private usage(b: Raw): WebUsage | undefined {
    const cost = num(b.costDollars?.total);
    return cost === undefined ? undefined : { costUsd: cost };
  }

  private meta<T>(data: T, r: { body: Raw; headers: Headers; resource: string }): ProviderData<T> {
    const out: ProviderData<T> = { data, resource: r.resource };
    const id = str(r.body.requestId) ?? r.headers.get("x-request-id") ?? undefined;
    if (id) out.requestId = id;
    return out;
  }

  private result(x: Raw, o: { content: boolean; maxCharacters: number }): WebResult {
    const text = str(x.text);
    return prune({ url: String(x.url), title: str(x.title), snippet: o.content ? undefined : text, ...(o.content ? cut(text, o.maxCharacters) : {}), publishedAt: str(x.publishedDate), author: str(x.author), score: num(x.score) }) as WebResult;
  }

  async search(query: string, o: WebSearchOptions) {
    const r = await this.post("/search", prune({ query, numResults: o.limit, type: "auto", includeDomains: o.includeDomains, excludeDomains: o.excludeDomains, contents: { text: { maxCharacters: o.content ? o.maxCharacters : 300 } } }));
    return this.meta(prune({ query, results: (r.body.results ?? []).map((x: Raw) => this.result(x, o)), usage: this.usage(r.body) }), r);
  }

  async similar(url: string, o: WebSearchOptions) {
    const r = await this.post("/findSimilar", prune({ url, numResults: o.limit, includeDomains: o.includeDomains, excludeDomains: o.excludeDomains, contents: { text: { maxCharacters: o.content ? o.maxCharacters : 300 } } }));
    return this.meta(prune({ url, results: (r.body.results ?? []).map((x: Raw) => this.result(x, o)), usage: this.usage(r.body) }), r);
  }

  async extract(urls: string[], maxCharacters: number) {
    const r = await this.post("/contents", { urls, text: { maxCharacters } });
    const pages = (r.body.results ?? []).map((x: Raw) => prune({ url: String(x.url), title: str(x.title), ...cut(str(x.text), maxCharacters) }) as WebPage);
    const failed = ((r.body.statuses ?? []) as Raw[]).filter((s) => s.status && s.status !== "success").map((s) => ({ url: String(s.id), error: String(s.error?.tag ?? s.status) }));
    return this.meta(prune({ pages, failed, usage: this.usage(r.body) }), r);
  }

  async answer(query: string) {
    const r = await this.post("/answer", { query });
    const answer = str(r.body.answer);
    if (!answer) throw new ProviderError("Exa returned no answer for this query", "not_listed");
    const citations = (r.body.citations ?? []).map((c: Raw) => prune({ url: String(c.url), title: str(c.title) }));
    return this.meta(prune({ query, answer, citations, usage: this.usage(r.body) }), r);
  }

  /**
   * Free key check: an intentionally empty search request. A valid key gets HTTP 400 (validation)
   * without performing a search; an invalid key gets 401.
   */
  async check(_scope: Scope): Promise<{ detail: string }> {
    try {
      await this.http.json(`${EXA}/search`, { method: "POST", headers: { "x-api-key": this.apiKey ?? "", "content-type": "application/json" }, body: "{}" }, { mapError: (s, h, d) => apiError("Exa", s, h, d) });
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "rejected" && error.status === 400) return { detail: "key accepted (validation request; no search performed, no cost)" };
      throw error;
    }
    return { detail: "key accepted" };
  }
}

// ------------------------------------------------------------------------------------- Firecrawl

const FIRECRAWL = "https://api.firecrawl.dev";

export class FirecrawlProvider implements WebSource {
  readonly name = "firecrawl";
  readonly kind: ProviderKind = "web";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["web.search", "web.extract", "web.map"];
  readonly auth = "Bearer API key (FIRECRAWL_API_KEY)";
  readonly envVars = ["FIRECRAWL_API_KEY"];
  readonly endpoint = `${FIRECRAWL}/v2`;
  readonly rateLimit = "Plan credits (scrape 1 per page, search 2 per 10 results, map 1); HTTP 402 without credits, 429 when rate limited";
  readonly docs = "https://docs.firecrawl.dev/api-reference/introduction";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "FIRECRAWL_API_KEY is not set";
  }

  private async request<T = Raw>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ body: T; resource: string }> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" } };
    if (body) init.body = JSON.stringify(body);
    const res = await this.http.json<T>(`${FIRECRAWL}${path}`, init, { timeoutMs: 90_000, mapError: (s, h, d) => apiError("Firecrawl", s, h, d) });
    const b = res.body as Raw;
    if (b && b.success === false) throw new ProviderError(`Firecrawl: ${str(b.error) ?? "request failed"}`, "http");
    return { body: res.body, resource: path.slice(1) };
  }

  async search(query: string, o: WebSearchOptions) {
    const r = await this.request<Raw>("POST", "/v2/search", prune({ query, limit: o.limit, scrapeOptions: o.content ? { formats: ["markdown"], onlyMainContent: true } : undefined }));
    const raw: Raw[] = Array.isArray(r.body.data) ? r.body.data : (r.body.data?.web ?? []);
    const results = raw
      .filter((x) => !o.includeDomains?.length || o.includeDomains.some((d) => new URL(String(x.url)).hostname.endsWith(d)))
      .filter((x) => !o.excludeDomains?.some((d) => new URL(String(x.url)).hostname.endsWith(d)))
      .map((x) => prune({ url: String(x.url), title: str(x.title) ?? str(x.metadata?.title), snippet: str(x.description), ...(o.content ? cut(str(x.markdown), o.maxCharacters) : {}) }) as WebResult);
    const notes = o.includeDomains?.length || o.excludeDomains?.length ? ["domain filters were applied by Splice to Firecrawl's results (Firecrawl search has no domain filter parameter)"] : undefined;
    const credits = num(r.body.creditsUsed);
    const out: ProviderData<{ query: string; results: WebResult[]; usage?: WebUsage }> = { data: prune({ query, results, usage: credits === undefined ? undefined : { credits } }), resource: r.resource };
    if (notes) out.notes = notes;
    return out;
  }

  /** One scrape per URL (Firecrawl has no batch endpoint for synchronous scrapes). */
  async extract(urls: string[], maxCharacters: number) {
    const pages: WebPage[] = [];
    const failed: Array<{ url: string; error: string }> = [];
    let credits = 0;
    for (const url of urls) {
      try {
        const r = await this.request<Raw>("POST", "/v2/scrape", { url, formats: ["markdown"], onlyMainContent: true });
        const d = r.body.data ?? {};
        credits += num(d.metadata?.creditsUsed) ?? 0;
        pages.push(prune({ url: str(d.metadata?.sourceURL) ?? url, title: str(d.metadata?.title), statusCode: num(d.metadata?.statusCode), ...cut(str(d.markdown), maxCharacters) }) as WebPage);
      } catch (error) {
        if (error instanceof ProviderError && (error.kind === "auth" || error.kind === "rate_limited")) throw error;
        failed.push({ url, error: (error as Error).message });
      }
    }
    if (pages.length === 0 && failed.length) throw new ProviderError(`Firecrawl could not scrape any URL: ${failed.map((f) => f.error).join("; ")}`, "http");
    return { data: prune({ pages, failed, usage: credits ? { credits } : undefined }), resource: "v2/scrape" };
  }

  async map(url: string, limit: number) {
    const r = await this.request<Raw>("POST", "/v2/map", { url, limit });
    const links = ((r.body.links ?? []) as unknown[]).slice(0, limit).map((l) => (typeof l === "string" ? { url: l } : prune({ url: String((l as Raw).url), title: str((l as Raw).title) })));
    return { data: { url, links }, resource: r.resource };
  }

  /** Free: credit usage of the team (spends no credits). */
  async check(_scope: Scope): Promise<{ detail: string }> {
    const r = await this.request<Raw>("GET", "/v2/team/credit-usage");
    const d = r.body.data ?? {};
    return { detail: `key accepted; ${d.remainingCredits ?? d.remaining_credits ?? "?"}/${d.planCredits ?? d.plan_credits ?? "?"} credits remaining` };
  }
}
