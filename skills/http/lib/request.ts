/**
 * Shared implementation of http.get / http.post.
 *
 * Security model: which hosts may be contacted is enforced by the Splice runtime, not here —
 * this package declares `network: ["*"]` (any public host) and the sandbox refuses private,
 * loopback, link-local and metadata addresses (also after DNS resolution and on every redirect
 * hop). This module adds request hygiene: URL validation, a fixed set of forwardable headers
 * (no Authorization/Cookie), timeouts and a response size limit.
 */

export interface RequestHeaders {
  accept?: string;
  "accept-language"?: string;
  "if-none-match"?: string;
  "if-modified-since"?: string;
  "user-agent"?: string;
}

export interface RequestInput {
  url: string;
  headers?: RequestHeaders;
  timeoutMs?: number;
  maxBytes?: number;
  responseType?: "auto" | "json" | "text";
}

export interface RequestBody {
  json?: unknown;
  text?: string;
  contentType?: string;
}

export interface HttpResponse {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  headers: Record<string, string>;
  bodyType: "json" | "text" | "base64" | "empty";
  json?: unknown;
  text?: string;
  base64?: string;
  bytes: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const USER_AGENT = "splice-http/0.1.0 (+https://spliceloom.io)";
/** Response headers returned to the caller. Set-Cookie and friends are never returned. */
const RESPONSE_HEADERS = ["content-type", "content-length", "etag", "last-modified", "cache-control", "date", "location", "retry-after"];
const FORWARDED_HEADERS: ReadonlyArray<keyof RequestHeaders> = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"];

function fail(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

export function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("INVALID_URL", `"${raw}" is not an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw fail("INVALID_URL", `protocol "${url.protocol}" is not supported (use http or https)`);
  if (url.username || url.password) throw fail("INVALID_URL", "URLs with embedded credentials are not allowed");
  if (!url.hostname) throw fail("INVALID_URL", "missing host");
  return url;
}

function isTextual(contentType: string): boolean {
  return contentType === "" || /^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw fail("RESPONSE_TOO_LARGE", `response is ${declared} bytes (limit ${maxBytes}; raise maxBytes up to 524288)`);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail("RESPONSE_TOO_LARGE", `response exceeded ${maxBytes} bytes (raise maxBytes up to 524288)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function request(method: "GET" | "POST", input: RequestInput, body?: RequestBody): Promise<HttpResponse> {
  const url = validateUrl(input.url);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  const headers = new Headers({ "user-agent": USER_AGENT, accept: "application/json, text/plain;q=0.9, */*;q=0.1" });
  for (const name of FORWARDED_HEADERS) {
    const value = input.headers?.[name];
    if (value !== undefined) headers.set(name, value);
  }
  const init: RequestInit = { method, headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) };
  if (body?.json !== undefined) {
    init.body = JSON.stringify(body.json);
    headers.set("content-type", "application/json");
  } else if (body?.text !== undefined) {
    init.body = body.text;
    headers.set("content-type", body.contentType ?? "text/plain; charset=utf-8");
  }

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(url.href, init);
    bytes = await readLimited(response, maxBytes);
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string; cause?: { message?: string } };
    // Sandbox denials must stay PERMISSION_DENIED; they are not network errors.
    if (err?.code === "ERR_ACCESS_DENIED") throw error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw fail("TIMEOUT", `no complete response within ${timeoutMs} ms`);
    if (typeof err?.message === "string" && /^[A-Z_]+: /.test(err.message)) throw error;
    throw fail("NETWORK_ERROR", `${err?.message ?? String(error)}${err?.cause?.message ? ` (${err.cause.message})` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const result: HttpResponse = {
    url: response.url || url.href,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: (response.url || url.href) !== url.href,
    headers: Object.fromEntries(RESPONSE_HEADERS.flatMap((h) => (response.headers.has(h) ? [[h, response.headers.get(h)!]] : []))),
    bodyType: "empty",
    bytes: bytes.byteLength,
  };
  if (bytes.byteLength === 0) return result;

  const mode = input.responseType ?? "auto";
  if (mode === "auto" && !isTextual(contentType)) {
    result.bodyType = "base64";
    result.base64 = toBase64(bytes);
    return result;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (mode === "json" || (mode === "auto" && /json/i.test(contentType))) {
    try {
      result.json = JSON.parse(text);
      result.bodyType = "json";
      return result;
    } catch (error) {
      if (mode === "json") throw fail("INVALID_JSON_RESPONSE", `response body is not valid JSON: ${(error as Error).message}`);
    }
  }
  result.bodyType = "text";
  result.text = text;
  return result;
}
