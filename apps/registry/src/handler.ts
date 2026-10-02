/**
 * Registry HTTP handler built only on Web-standard Request/Response. The same code is served by
 * the Cloudflare Worker (worker.ts) and by the local Node.js server (node.ts).
 */
import { ARCHIVE_CONTENT_TYPE, BUNDLE_CONTENT_TYPE, INTEGRITY_HEADER, REGISTRY_API_VERSION, formatPackageId, redactSecrets, type ApiErrorBody } from "@spliceloom/spec";
import { SHA256_HEX_PATTERN, bearerToken, constantTimeEqual, hashToken } from "./auth.js";
import { DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from "./ratelimit.js";
import { RegistryError, type AuthUser, type RegistryService, type TokenOptions } from "./service.js";
import type { ArtifactStore } from "./storage.js";
import { handleMcpHttp } from "@spliceloom/mcp/http";
import { RegistryMcpBackend } from "./mcp.js";

export interface HandlerOptions {
  service: RegistryService;
  /**
   * SHA-256 (hex) of the admin token. The admin API is disabled when unset.
   * Only the hash is configured, so the registry never holds the plaintext admin token.
   */
  adminTokenHash?: string;
  /** Optional rate limiters. Without them no limits are applied. */
  rateLimits?: RateLimits;
  /** Previous artifact store, enabling `POST /admin/artifacts/migrate`. */
  legacyArtifacts?: ArtifactStore;
}

export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
const RETRY_AFTER_SECONDS = 60;

/** Best-effort client identifier for rate limiting. On Cloudflare, cf-connecting-ip is set by the edge. */
function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function optionalStringList(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new RegistryError("BAD_REQUEST", 400, `"${key}" must be a list of strings`);
  }
  return value as string[];
}

function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new RegistryError("BAD_REQUEST", 400, `"${key}" must be an integer`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new RegistryError("BAD_REQUEST", 400, `"${key}" must be a boolean`);
  return value;
}
const MAX_JSON_BYTES = 64 * 1024;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function errorResponse(status: number, code: string, message: string, details?: string[]): Response {
  const body: ApiErrorBody = { error: details && details.length > 0 ? { code, message, details } : { code, message } };
  return json(body, status);
}

async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) throw new RegistryError("PAYLOAD_TOO_LARGE", 413, `Request body exceeds ${max} bytes`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) throw new RegistryError("PAYLOAD_TOO_LARGE", 413, `Request body exceeds ${max} bytes`);
  return bytes;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new RegistryError("BAD_REQUEST", 400, "Request body must be a JSON object");
}

function stringField(body: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new RegistryError("BAD_REQUEST", 400, `"${key}" must be a non-empty string`);
  return value;
}

export function createRegistryHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const { service } = options;
  const adminHash = options.adminTokenHash && SHA256_HEX_PATTERN.test(options.adminTokenHash) ? options.adminTokenHash : undefined;
  const limits = options.rateLimits ?? {};

  async function enforce(limiter: RateLimiter | undefined, key: string): Promise<void> {
    if (limiter && !(await limiter.limit(key))) {
      throw new RegistryError("RATE_LIMITED", 429, "Too many requests. Try again later.");
    }
  }

  function tokenOptions(body: Record<string, unknown>): TokenOptions {
    const opts: TokenOptions = {};
    const label = stringField(body, "label", false);
    if (label !== undefined) opts.label = label;
    const namespaces = optionalStringList(body, "namespaces");
    if (namespaces !== undefined) opts.namespaces = namespaces;
    const days = optionalInteger(body, "expiresInDays");
    if (days !== undefined) opts.expiresInDays = days;
    return opts;
  }

  /** Rejects clients that failed authentication too often, before any credential is checked. */
  async function guardFailures(request: Request): Promise<string> {
    const key = `ip:${clientKey(request)}`;
    if (limits.authFailures && (await limits.authFailures.blocked(key))) {
      const error = new RegistryError("RATE_LIMITED", 429, "Too many failed authentication attempts. Try again later.");
      error.retryAfter = DEFAULT_RATE_LIMITS.authFailures.periodSeconds;
      throw error;
    }
    return key;
  }

  async function requireUser(request: Request): Promise<AuthUser> {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) throw new RegistryError("UNAUTHENTICATED", 401, "Authentication required. Run `splice login`.");
    const key = await guardFailures(request);
    const user = await service.authenticate(token);
    if (!user) {
      await limits.authFailures?.record(key);
      throw new RegistryError("UNAUTHENTICATED", 401, "Invalid, expired or revoked token");
    }
    return user;
  }

  async function requireAdmin(request: Request): Promise<void> {
    if (!adminHash) throw new RegistryError("ADMIN_DISABLED", 403, "The admin API is not enabled on this registry");
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) throw new RegistryError("UNAUTHENTICATED", 401, "Admin token required");
    const key = await guardFailures(request);
    if (!constantTimeEqual(await hashToken(token), adminHash)) {
      await limits.authFailures?.record(key);
      throw new RegistryError("FORBIDDEN", 403, "Invalid admin token");
    }
  }

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    try {
      let segments: string[];
      try {
        segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new RegistryError("BAD_REQUEST", 400, "Malformed URL encoding");
      }
      const [first, a, b, c, d] = segments;
      const n = segments.length;

      if (method === "GET" && n === 0) {
        return json({
          name: "splice-registry",
          apiVersion: REGISTRY_API_VERSION,
          admin: adminHash ? "enabled" : "disabled",
          endpoints: [
            "GET /health",
            "GET /packages/search?q=",
            "GET /packages/:namespace/:name",
            "GET /packages/:namespace/:name/versions",
            "GET /packages/:namespace/:name/:version",
            "GET /packages/:namespace/:name/:version/download",
            "GET /packages/:namespace/:name/:version/provenance",
            "POST /publish",
            "GET /auth/whoami",
            "GET|POST /auth/tokens",
            "DELETE /auth/tokens/:id",
            "GET /namespaces/:namespace",
            "PUT|DELETE /namespaces/:namespace/maintainers/:user",
            "POST /mcp (MCP Streamable HTTP, bearer token)",
          ],
        });
      }
      if (method === "GET" && first === "health" && n === 1) return json(service.health());

      if (first === "packages" && method === "GET") {
        if (n === 2 && a === "search") {
          return json(await service.search(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? "20")));
        }
        if (n >= 3 && a && b) {
          const id = formatPackageId(a, b);
          if (n === 3) return json(await service.getPackage(id));
          if (n === 4 && c === "versions") return json(await service.listVersions(id));
          if (n === 4 && c) return json(await service.getVersion(id, c));
          if (n === 5 && c && d === "provenance") return json(await service.getProvenance(id, c));
          if (n === 5 && c && d === "download") {
            const artifact = await service.getArtifact(id, c);
            return new Response(artifact.bytes as Uint8Array<ArrayBuffer>, {
              status: 200,
              headers: {
                "content-type": artifact.filename.endsWith(".tar.gz") ? ARCHIVE_CONTENT_TYPE : BUNDLE_CONTENT_TYPE,
                "content-length": String(artifact.bytes.byteLength),
                "content-disposition": `attachment; filename="${artifact.filename}"`,
                [INTEGRITY_HEADER]: artifact.integrity,
                // Published versions are immutable.
                "cache-control": "public, max-age=31536000, immutable",
              },
            });
          }
        }
      }

      if (first === "namespaces" && a && n === 2 && method === "GET") {
        return json(await service.getNamespace(a));
      }

      // Everything below is authenticated: limit per client before verifying credentials.
      const authenticated =
        first === "publish" || first === "auth" || first === "admin" || first === "mcp" || (first === "namespaces" && method !== "GET");
      if (authenticated) await enforce(limits.auth, `ip:${clientKey(request)}`);

      if (first === "mcp" && n === 1) {
        // Remote MCP (discovery only). Authentication is explicit: any valid registry token.
        const user = await requireUser(request);
        return await handleMcpHttp(request, { backend: new RegistryMcpBackend(service, user, `api-${REGISTRY_API_VERSION}`) });
      }

      if (first === "publish" && n === 1 && method === "POST") {
        const user = await requireUser(request);
        await enforce(limits.publish, `user:${user.id}`);
        return json(await service.publish(await readBytes(request, MAX_PUBLISH_BYTES), user), 201);
      }

      if (first === "auth" && a === "whoami" && n === 2 && method === "GET") {
        return json(await service.whoami(await requireUser(request)));
      }

      if (first === "auth" && a === "tokens") {
        if (n === 2 && method === "GET") return json(await service.listTokens(await requireUser(request)));
        if (n === 2 && method === "POST") {
          const user = await requireUser(request);
          return json(await service.createUserToken(user, tokenOptions(await readJson(request))), 201);
        }
        if (n === 3 && b && method === "DELETE") return json(await service.revokeUserToken(await requireUser(request), b));
      }

      if (first === "namespaces" && a && b === "maintainers" && c && n === 4) {
        if (method === "PUT") return json(await service.addMaintainer(await requireUser(request), a, c));
        if (method === "DELETE") return json(await service.removeMaintainer(await requireUser(request), a, c));
      }

      if (first === "admin") {
        await enforce(limits.admin, `ip:${clientKey(request)}`);
        await requireAdmin(request);
        if (method === "POST" && a === "users" && n === 2) {
          return json(await service.createUser(stringField(await readJson(request), "name", true)!), 201);
        }
        if (method === "POST" && a === "users" && b && c === "tokens" && n === 4) {
          const body = await readJson(request);
          const opts: TokenOptions & { canManage?: boolean } = tokenOptions(body);
          const canManage = optionalBoolean(body, "canManage");
          if (canManage !== undefined) opts.canManage = canManage;
          return json(await service.createToken(b, opts), 201);
        }
        if (method === "POST" && a === "artifacts" && b === "migrate" && n === 3) {
          if (!options.legacyArtifacts) throw new RegistryError("BAD_REQUEST", 400, "No legacy artifact store is configured");
          return json(await service.migrateArtifacts(options.legacyArtifacts));
        }
        if (method === "POST" && a === "tokens" && b && c === "revoke" && n === 4) {
          return json(await service.revokeToken(b));
        }
        if (method === "PUT" && a === "namespaces" && b && n === 3) {
          const body = await readJson(request);
          const owner = body.owner;
          if (owner !== null && (typeof owner !== "string" || owner.length === 0)) {
            throw new RegistryError("BAD_REQUEST", 400, '"owner" must be a user name or null');
          }
          return json(await service.setNamespaceOwner(b, owner as string | null));
        }
      }

      return errorResponse(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof RegistryError) {
        const response = errorResponse(error.status, error.code, error.message, error.details);
        if (error.status === 429) response.headers.set("retry-after", String(error.retryAfter ?? RETRY_AFTER_SECONDS));
        return response;
      }
      // Never log request headers or bodies: they may contain tokens.
      console.error(redactSecrets(`registry: unexpected error: ${(error as Error)?.stack ?? String(error)}`));
      if (isStorageUnavailable(error)) {
        // e.g. the Cloudflare account's D1 daily quota: temporary, the client should retry later.
        const response = errorResponse(503, "STORAGE_UNAVAILABLE", "The registry database is temporarily unavailable. Nothing was changed; try again later.");
        response.headers.set("retry-after", "3600");
        return response;
      }
      return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
    }
  };

  return async (request) => {
    const method = request.method.toUpperCase();
    const publicRead = isPublicReadPath(new URL(request.url).pathname);
    // Browsers (e.g. the Splice website) may read public registry data cross-origin. Only the
    // anonymous, read-only GET routes get CORS; authenticated/admin routes never do, and no
    // credentials are ever allowed cross-origin.
    if (method === "OPTIONS" && publicRead) return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    const response = await route(request);
    if (publicRead && method === "GET") {
      for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
    }
    return response;
  };
}

/** Database errors that are temporary conditions of the platform (quota, overload), not bugs. */
export function isStorageUnavailable(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /D1_ERROR/.test(message) && /(exceeded|limit|overloaded|unavailable|too many|try again)/i.test(message);
}

/** Anonymous read-only routes: registry info, health, packages (search/metadata/provenance/download), namespace info. */
export function isPublicReadPath(pathname: string): boolean {
  return /^\/(?:health\/?)?$/.test(pathname) || /^\/packages(?:\/|$)/.test(pathname) || /^\/namespaces\/[^/]+\/?$/.test(pathname);
}

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": `${INTEGRITY_HEADER}, content-length, content-disposition, retry-after`,
  vary: "origin",
};

const CORS_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
  "access-control-max-age": "86400",
};
