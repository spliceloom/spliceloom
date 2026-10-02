/**
 * HTTP for providers. Requests go through Splice's network guard (createGuardedFetch from
 * @spliceloom/runtime): only the provider hosts registered for this process may be contacted,
 * every resolved address must be public (checked inside the socket's DNS lookup), redirects are
 * re-checked, TLS is always verified. Responses are size- and time-limited, and every error
 * message is redacted of provider secrets before it leaves this module.
 */
import { lookup } from "node:dns/promises";
import { createGuardedFetch } from "@spliceloom/runtime";
import { redactSecrets } from "@spliceloom/spec";
import { ProviderError } from "./result.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Hosts this client may contact (exact host names). */
  hosts: string[];
  secrets: string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam: replaces the guarded fetch (unit tests only). */
  fetch?: FetchLike;
  /** Client-side limit that keeps requests within the provider's documented rate limit. */
  rateLimit?: { requests: number; perMs: number };
}

export interface RequestOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Provider-specific error mapping (e.g. GitHub 403 = rate limit vs. forbidden); undefined = default. */
  mapError?: (status: number, headers: Headers, detail: string) => ProviderError | undefined;
}

export interface HttpResponse<T> {
  status: number;
  body: T;
  headers: Headers;
  ms: number;
}

const denied = (message: string) => Object.assign(new Error(message), { code: "ERR_ACCESS_DENIED" });

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  private readonly sent: number[] = [];

  constructor(private readonly options: HttpClientOptions) {
    const lookupAll = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    this.fetchImpl = options.fetch ?? (createGuardedFetch(options.hosts, lookupAll, denied) as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  }

  redact(text: string): string {
    return redactSecrets(text, this.options.secrets);
  }

  /** Client-side rate limit: refuses (without a request) when the documented limit would be exceeded. */
  private throttle(): void {
    const limit = this.options.rateLimit;
    if (!limit) return;
    const now = Date.now();
    while (this.sent.length && now - this.sent[0]! > limit.perMs) this.sent.shift();
    if (this.sent.length >= limit.requests) {
      const retry = Math.ceil((limit.perMs - (now - this.sent[0]!)) / 1000);
      throw new ProviderError(`client-side rate limit: ${limit.requests} requests per ${limit.perMs / 1000}s reached (provider's documented limit); retry in ${retry}s`, "rate_limited", 429, retry);
    }
    this.sent.push(now);
  }

  private async fetchText(url: string, init: RequestInit, options: RequestOptions, accept: string): Promise<{ response: Response; text: string; ms: number }> {
    this.throttle();
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxBytes = options.maxBytes ?? this.maxBytes;
    try {
      const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { accept, "user-agent": "splice-data/0.1 (+https://github.com/spliceloom)", ...(init.headers as Record<string, string> | undefined) } });
      const declared = Number(response.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderError(`response too large (${declared} bytes, limit ${maxBytes})`, "invalid_response", response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new ProviderError(`response too large (${bytes.byteLength} bytes, limit ${maxBytes})`, "invalid_response", response.status);
      return { response, text: new TextDecoder().decode(bytes), ms: Date.now() - started };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const err = error as { name?: string; code?: string; message?: string; cause?: { message?: string; code?: string } };
      if (err?.code === "ERR_ACCESS_DENIED") throw new ProviderError(this.redact(`blocked by the Splice network guard: ${err.message}`), "network");
      if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new ProviderError(`no response within ${timeoutMs} ms`, "network");
      const cause = err?.cause?.message ? ` (${err.cause.message})` : "";
      throw new ProviderError(this.redact(`network error: ${err?.message ?? String(error)}${cause}`), "network");
    }
  }

  /** Performs a request and parses JSON. Throws ProviderError (already redacted) on any failure. */
  async json<T = unknown>(url: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const { response, text, ms } = await this.fetchText(url, init, options, "application/json");
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      if (!response.ok) throw this.httpError(response, text.slice(0, 200), options);
      throw new ProviderError(`invalid JSON from provider (HTTP ${response.status})`, "invalid_response", response.status);
    }
    if (!response.ok) throw this.httpError(response, typeof body === "object" ? JSON.stringify(body).slice(0, 300) : String(body), options);
    return { status: response.status, body: body as T, headers: response.headers, ms };
  }

  /** Performs a request and returns the body as text (size-limited). */
  async text(url: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<HttpResponse<string>> {
    const { response, text, ms } = await this.fetchText(url, init, options, "*/*");
    if (!response.ok) throw this.httpError(response, text.slice(0, 200), options);
    return { status: response.status, body: text, headers: response.headers, ms };
  }

  private httpError(response: Response, detail: string, options: RequestOptions = {}): ProviderError {
    const status = response.status;
    const mapped = options.mapError?.(status, response.headers, this.redact(detail.replace(/\s+/g, " ").trim()));
    if (mapped) return mapped;
    const message = this.redact(`HTTP ${status}: ${detail.replace(/\s+/g, " ").trim()}`);
    if (status === 401 || status === 403) return new ProviderError(message, "auth", status);
    if (status === 429) {
      const retry = Number(response.headers.get("retry-after") ?? "NaN");
      return new ProviderError(message, "rate_limited", status, Number.isFinite(retry) ? retry : undefined);
    }
    if (status === 404) return new ProviderError(message, "not_found", status);
    return new ProviderError(message, "http", status);
  }
}

/** Host of a URL (for the network-guard allowlist). */
export const hostOf = (url: string) => new URL(url).hostname.toLowerCase();

/** Rate-limit state from common response headers (x-ratelimit-*), when the provider sends them. */
export function rateLimitFrom(headers: Headers): { limit?: number; remaining?: number; resetAt?: string; resource?: string } | undefined {
  const num = (name: string) => {
    const v = Number(headers.get(name) ?? "NaN");
    return Number.isFinite(v) ? v : undefined;
  };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  const reset = num("x-ratelimit-reset");
  if (limit === undefined && remaining === undefined) return undefined;
  const out: { limit?: number; remaining?: number; resetAt?: string; resource?: string } = {};
  if (limit !== undefined) out.limit = limit;
  if (remaining !== undefined) out.remaining = remaining;
  // Epoch seconds (GitHub) vs. seconds-until-reset: only epoch values are converted to a time.
  if (reset !== undefined && reset > 1_000_000_000) out.resetAt = new Date(reset * 1000).toISOString();
  const resource = headers.get("x-ratelimit-resource");
  if (resource) out.resource = resource;
  return out;
}