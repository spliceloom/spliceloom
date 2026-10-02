/**
 * Network policy for sandboxed tools (used by host.mts).
 *
 * Tools only get this module's `fetch`. It is implemented on node:http/node:https (not the
 * built-in undici fetch) so the address check happens *inside the socket's DNS lookup*: the
 * address that is validated is exactly the address the connection uses. There is no second,
 * unchecked resolution, which closes the classic DNS-rebinding gap between "check" and "connect".
 *
 * A request is allowed when
 *   1. the protocol is http/https and the URL has no embedded credentials,
 *   2. the host matches a declared `permissions.network` pattern (`*` = any host), and
 *   3. every address the host resolves to is public — private, loopback, link-local (incl. cloud
 *      metadata 169.254.169.254), CGNAT, multicast, reserved, documentation and IPv6 transition
 *      ranges are refused — unless the package declares that exact IP literal or `localhost`,
 *      which is an explicit, reviewable grant.
 * Redirects are followed here, hop by hop, with the same checks (max 5).
 *
 * This is an in-process control: it relies on tools having no other way to open sockets. The
 * host removes the ones Node offers (see host.mts); the Node.js permission model itself has no
 * network restriction in Node 24.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const ANY_PUBLIC_HOST = "*";

// Separate lists: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules too, so a
// single list containing ::ffff:0:0/96 would classify every IPv4 address as blocked.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96], // IPv4-mapped
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, "ipv6");
}

/** True for any address that is not a globally routable unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked4.check(address, "ipv4");
  if (family === 6) return blocked6.check(address, "ipv6");
  return true; // not an IP at all: never treat as public
}

/** URL hostname without IPv6 brackets or a trailing dot, lowercased. */
export function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.$/, "");
}

function matchesPattern(host: string, pattern: string): boolean {
  if (pattern === ANY_PUBLIC_HOST) return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

export type LookupAll = (host: string) => Promise<string[]>;

export type TargetDecision = { allowed: true; explicit: boolean } | { allowed: false; reason: string };

/**
 * Pre-connection check (no DNS): protocol, credentials, declared patterns, IP literals and
 * `localhost` names. `explicit` means the exact IP literal / `localhost` was declared, so the
 * public-address rule does not apply to this host.
 */
export function checkNetworkTarget(url: URL, patterns: readonly string[]): TargetDecision {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `fetch() to protocol "${url.protocol}" is denied` };
  }
  if (url.username || url.password) return { allowed: false, reason: "URLs with embedded credentials are denied" };
  const host = normalizeHost(url.hostname);
  if (!patterns.some((p) => matchesPattern(host, p))) {
    return { allowed: false, reason: `Network access to "${host}" is denied. Declare it in manifest permissions.network.` };
  }
  if (patterns.includes(host) && (isIP(host) !== 0 || host === "localhost")) return { allowed: true, explicit: true };
  if (isIP(host) !== 0 && isNonPublicAddress(host)) return { allowed: false, reason: `Network access to "${host}" is denied: ${host} is not a public address` };
  if (host === "localhost" || host.endsWith(".localhost")) return { allowed: false, reason: `Network access to "${host}" is denied: ${host} is not a public address` };
  return { allowed: true, explicit: false };
}

/** Checks resolved addresses (all of them must be public unless the host was explicitly granted). */
export function checkResolvedAddresses(host: string, addresses: readonly string[], explicit: boolean): { allowed: true } | { allowed: false; reason: string } {
  if (addresses.length === 0) return { allowed: false, reason: `Could not resolve "${host}"` };
  if (explicit) return { allowed: true };
  const bad = addresses.find(isNonPublicAddress);
  return bad ? { allowed: false, reason: `Network access to "${host}" is denied: ${bad} (resolved from ${host}) is not a public address` } : { allowed: true };
}

/**
 * A `lookup` for net/tls connections that validates what it returns. Node calls it for the
 * connection itself, so validation and connection use the same answer (no rebinding window).
 */
export function createCheckedLookup(lookupAll: LookupAll, explicit: boolean, denied: (message: string) => Error, onLookup?: (host: string) => void): LookupFunction {
  return (hostname, options, callback) => {
    onLookup?.(hostname);
    const done = callback as (err: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;
    lookupAll(hostname).then(
      (addresses) => {
        const host = normalizeHost(hostname);
        const decision = checkResolvedAddresses(host, addresses, explicit);
        if (!decision.allowed) return done(addresses.length === 0 ? Object.assign(new Error(decision.reason), { code: "ENOTFOUND" }) : (denied(decision.reason) as NodeJS.ErrnoException));
        const family = (options as { family?: number | string }).family;
        const wanted = family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : 0;
        const usable = addresses.filter((a) => wanted === 0 || isIP(a) === wanted);
        if (usable.length === 0) return done(Object.assign(new Error(`No IPv${wanted} address for "${host}"`), { code: "ENOTFOUND" }));
        if ((options as { all?: boolean }).all) return done(null, usable.map((a) => ({ address: a, family: isIP(a) })));
        return done(null, usable[0], isIP(usable[0]!));
      },
      (error: NodeJS.ErrnoException) => done(error),
    );
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
export const MAX_REDIRECTS = 5;

type FetchFn = typeof fetch;

async function bodyBytes(body: RequestInit["body"], headers: Headers): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return new TextEncoder().encode(body);
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) {
    if (!headers.has("content-type") && body.type) headers.set("content-type", body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new TypeError("Unsupported request body type (use a string, bytes, Blob or URLSearchParams)");
}

function toHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
  return headers;
}

function decoded(res: IncomingMessage, headers: Headers): Readable {
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
  if (!decoder) return res;
  headers.delete("content-encoding");
  headers.delete("content-length");
  res.on("error", (e) => decoder.destroy(e));
  return res.pipe(decoder);
}

interface Hop {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

function send(hop: Hop, lookup: LookupFunction): Promise<{ res: IncomingMessage; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const { url, signal } = hop;
    if (signal?.aborted) return reject(signal.reason);
    const headers: Record<string, string> = {};
    hop.headers.forEach((value, key) => (headers[key] = value));
    headers.host ??= url.host;
    headers["accept-encoding"] ??= "gzip, deflate, br";
    if (hop.body) headers["content-length"] = String(hop.body.byteLength);
    const options = {
      method: hop.method,
      hostname: normalizeHost(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers,
      lookup,
      agent: false as const,
    };
    const req = url.protocol === "https:" ? httpsRequest({ ...options, servername: isIP(normalizeHost(url.hostname)) ? undefined : normalizeHost(url.hostname) }) : httpRequest(options);
    const onAbort = () => req.destroy(signal!.reason instanceof Error ? signal!.reason : new DOMException("This operation was aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("response", (res) => {
      res.on("close", () => signal?.removeEventListener("abort", onAbort));
      resolve({ res, headers: toHeaders(res) });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ERR_ACCESS_DENIED" || error.name === "TimeoutError" || error.name === "AbortError") return reject(error);
      reject(new TypeError("fetch failed", { cause: error }));
    });
    req.end(hop.body);
  });
}

/**
 * A fetch() for sandboxed tools: every hop is checked (patterns, literals) and every connection
 * resolves through the checked lookup. Denials throw errors with code ERR_ACCESS_DENIED; network
 * failures throw TypeError("fetch failed", { cause }), like the built-in fetch.
 */
export function createGuardedFetch(patterns: readonly string[], lookupAll: LookupAll, denied: (message: string) => Error, onLookup?: (host: string) => void): FetchFn {
  return (async (resource: string | URL | Request, init?: RequestInit) => {
    const request = resource instanceof Request ? resource : undefined;
    let url = new URL(request ? request.url : resource instanceof URL ? resource.href : String(resource));
    const headers = new Headers(init?.headers ?? request?.headers);
    let method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let body = init && "body" in init ? await bodyBytes(init.body, headers) : request && request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const redirectMode = init?.redirect ?? request?.redirect ?? "follow";
    const signal = init?.signal ?? request?.signal ?? undefined;
    if ((method === "GET" || method === "HEAD") && body) throw new TypeError("Request with GET/HEAD method cannot have body");

    for (let hop = 0; ; hop++) {
      const decision = checkNetworkTarget(url, patterns);
      if (!decision.allowed) throw denied(hop === 0 ? decision.reason : `Redirect blocked: ${decision.reason}`);
      const lookup = createCheckedLookup(lookupAll, decision.explicit, (m) => denied(hop === 0 ? m : `Redirect blocked: ${m}`), onLookup);
      const { res, headers: resHeaders } = await send({ url, method, headers, body, signal }, lookup);
      const location = resHeaders.get("location");
      if (redirectMode !== "manual" && REDIRECT_STATUSES.has(res.statusCode ?? 0) && location) {
        res.resume();
        if (redirectMode === "error") throw new TypeError("fetch failed: redirect received with redirect: \"error\"");
        if (hop >= MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects`);
        const next = new URL(location, url);
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        if (next.origin !== url.origin) {
          // Like browsers: credentials never follow a redirect to another origin.
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        headers.delete("host");
        url = next;
        continue;
      }
      const status = res.statusCode ?? 0;
      const noBody = NULL_BODY_STATUSES.has(status) || method === "HEAD";
      const stream = noBody ? null : decoded(res, resHeaders);
      if (noBody) res.resume();
      if (stream && signal) {
        const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        stream.on("close", () => signal.removeEventListener("abort", abort));
      }
      const response = new Response(stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null, {
        status: status < 200 || status > 599 ? 502 : status,
        statusText: res.statusMessage ?? "",
        headers: resHeaders,
      });
      Object.defineProperty(response, "url", { value: url.href });
      Object.defineProperty(response, "redirected", { value: hop > 0 });
      return response;
    }
  }) as FetchFn;
}
