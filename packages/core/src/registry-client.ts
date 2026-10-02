import {
  BUNDLE_CONTENT_TYPE,
  INTEGRITY_HEADER,
  PUBLISH_PATH,
  TOKENS_PATH,
  WHOAMI_PATH,
  downloadPath,
  maintainerPath,
  namespacePath,
  packagePath,
  tokenPath,
  searchPath,
  versionPath,
  versionsPath,
  type ApiErrorBody,
  type CreatedTokenResponse,
  type NamespaceResponse,
  type PackageResponse,
  type TokenListResponse,
  type PublishResponse,
  type SearchResponse,
  type VersionResponse,
  type VersionsResponse,
  type WhoamiResponse,
} from "@spliceloom/spec";
import { CoreError, type CoreErrorCode } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STATUS_CODES: Record<number, CoreErrorCode> = {
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "PACKAGE_NOT_FOUND",
  409: "VERSION_EXISTS",
  422: "INVALID_PACKAGE",
  429: "RATE_LIMITED",
  503: "REGISTRY_UNAVAILABLE",
};

/** Next steps shown with registry errors (what the developer can do). */
const STATUS_HINTS: Partial<Record<CoreErrorCode, string>> = {
  UNAUTHENTICATED: "Run `splice login` (or set SPLICE_TOKEN). Check the token with `splice whoami`.",
  FORBIDDEN: "Your token cannot do this: check `splice whoami` (namespaces, scope) or ask the namespace owner.",
  RATE_LIMITED: "Too many requests from this client; wait and try again.",
  REGISTRY_UNAVAILABLE: "The registry is temporarily unavailable. Nothing was changed; try again later (installed packages keep working offline).",
};

/** HTTP client for the registry API v2 (see @spliceloom/spec registry-api). */
export class RegistryClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new CoreError("REGISTRY_UNREACHABLE", `Could not reach the registry at ${this.baseUrl}`, {
        details: [(error as Error).message],
        hint: "Check the URL with `splice config get registry`. For local development: `splice config set registry local`.",
      });
    }
    if (response.ok) return response;

    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    const code = STATUS_CODES[response.status] ?? "REGISTRY_ERROR";
    const options: { details: string[]; hint?: string } = { details: body?.error?.details ?? [] };
    const hint = STATUS_HINTS[code] ?? (response.status >= 500 ? `The registry at ${this.baseUrl} failed (HTTP ${response.status}); try again later.` : undefined);
    if (hint) options.hint = hint;
    throw new CoreError(code, code === "REGISTRY_ERROR" ? `Registry error: ${message}` : message, options);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CoreError("REGISTRY_ERROR", `Registry returned invalid JSON for ${path}`);
    }
  }

  search(query: string, limit = 20): Promise<SearchResponse> {
    return this.json<SearchResponse>(searchPath(query, limit));
  }

  getPackage(id: string): Promise<PackageResponse> {
    return this.json<PackageResponse>(packagePath(id));
  }

  listVersions(id: string): Promise<VersionsResponse> {
    return this.json<VersionsResponse>(versionsPath(id));
  }

  getVersion(id: string, version: string): Promise<VersionResponse> {
    return this.json<VersionResponse>(versionPath(id, version));
  }

  /** Downloads an artifact. The caller must verify its integrity against the version metadata. */
  async downloadArtifact(id: string, version: string): Promise<{ bytes: Uint8Array; integrity: string | null }> {
    const response = await this.request(downloadPath(id, version), { headers: { accept: BUNDLE_CONTENT_TYPE } });
    return { bytes: new Uint8Array(await response.arrayBuffer()), integrity: response.headers.get(INTEGRITY_HEADER) };
  }

  whoami(token: string): Promise<WhoamiResponse> {
    return this.json<WhoamiResponse>(WHOAMI_PATH, { headers: { authorization: `Bearer ${token}` } });
  }

  listTokens(token: string): Promise<TokenListResponse> {
    return this.json<TokenListResponse>(TOKENS_PATH, { headers: { authorization: `Bearer ${token}` } });
  }

  createToken(token: string, options: { label?: string; namespaces?: string[]; expiresInDays?: number }): Promise<CreatedTokenResponse> {
    return this.json<CreatedTokenResponse>(TOKENS_PATH, {
      method: "POST",
      body: JSON.stringify(options),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  }

  revokeToken(token: string, id: string): Promise<{ id: string; revoked: true }> {
    return this.json(tokenPath(id), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  }

  getNamespace(namespace: string): Promise<NamespaceResponse> {
    return this.json<NamespaceResponse>(namespacePath(namespace));
  }

  addMaintainer(token: string, namespace: string, user: string): Promise<NamespaceResponse> {
    return this.json<NamespaceResponse>(maintainerPath(namespace, user), { method: "PUT", headers: { authorization: `Bearer ${token}` } });
  }

  removeMaintainer(token: string, namespace: string, user: string): Promise<NamespaceResponse> {
    return this.json<NamespaceResponse>(maintainerPath(namespace, user), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  }

  publish(bundle: Uint8Array, token: string): Promise<PublishResponse> {
    return this.json<PublishResponse>(PUBLISH_PATH, {
      method: "POST",
      body: bundle as Uint8Array<ArrayBuffer>,
      headers: { authorization: `Bearer ${token}`, "content-type": BUNDLE_CONTENT_TYPE },
    });
  }
}
