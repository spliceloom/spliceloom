/**
 * GitHub Releases artifact store (production backend).
 *
 * Layout: one release per package, tag `<tagPrefix><namespace>/<name>` (default `pkg/splice/example`),
 * one asset per version, named `<namespace>-<name>-<version>.tar.gz`. The deterministic key
 * (`packages/<ns>/<name>/<version>/<sha256>.tar.gz`) maps onto that release/asset; the content hash
 * is verified against GitHub's asset digest on upload and by every client on download.
 * Existing assets are never replaced: re-uploading identical bytes is a no-op, different bytes fail.
 *
 * Only Web APIs (fetch) are used, so it runs in the Cloudflare Worker. The token never appears in
 * errors, logs or return values.
 */
import { parseArtifactKey, ArtifactStoreError, type ArtifactPutOptions, type ArtifactStore, type StoredArtifact } from "./storage.js";

export interface GitHubReleaseConfig {
  owner: string;
  repo: string;
  /** Fine-grained token with "Contents: read and write" on the artifact repository. */
  token: string;
  /** Default `pkg/`. */
  tagPrefix?: string;
  /** Overridable for tests / GitHub Enterprise. */
  apiUrl?: string;
  uploadUrl?: string;
  fetch?: typeof fetch;
}

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  /** "sha256:<hex>" (GitHub computes it for release assets). */
  digest?: string | null;
}

interface Release {
  id: number;
  tag_name: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export class GitHubReleaseArtifactStore implements ArtifactStore {
  readonly backend = "github-releases";
  private readonly apiUrl: string;
  private readonly uploadUrl: string;
  private readonly tagPrefix: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitHubReleaseConfig) {
    if (!NAME_PATTERN.test(config.owner) || !NAME_PATTERN.test(config.repo)) {
      throw new ArtifactStoreError("Invalid GitHub owner/repo configuration");
    }
    if (!config.token) throw new ArtifactStoreError("GitHub token is not configured");
    this.apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.uploadUrl = (config.uploadUrl ?? "https://uploads.github.com").replace(/\/+$/, "");
    this.tagPrefix = config.tagPrefix ?? "pkg/";
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Release tag and asset name for a key. */
  locate(key: string): { tag: string; assetName: string; sha256: string; release: string } {
    const k = parseArtifactKey(key);
    const suffix = k.extension === ".tar.gz" ? ".tar.gz" : ".splice.json";
    return {
      tag: `${this.tagPrefix}${k.namespace}/${k.name}`,
      assetName: `${k.namespace}-${k.name}-${k.version}${suffix}`,
      sha256: k.sha256,
      release: `@${k.namespace}/${k.name}`,
    };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "splice-registry",
      ...extra,
    };
  }

  private repoPath(path: string): string {
    return `/repos/${this.config.owner}/${this.config.repo}${path}`;
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new ArtifactStoreError(`GitHub ${what} failed: network error (${(error as Error).message})`);
    }
    return response;
  }

  private async fail(response: Response, what: string): Promise<never> {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = `: ${body.message.slice(0, 200)}`;
    } catch {
      // ignore
    }
    const hint =
      response.status === 401 ? " (token invalid or expired)" : response.status === 403 || response.status === 404 ? " (check token permissions and repository)" : "";
    throw new ArtifactStoreError(`GitHub ${what} failed with HTTP ${response.status}${detail}${hint}`, response.status);
  }

  private async getRelease(tag: string): Promise<Release | null> {
    const res = await this.call(`${this.apiUrl}${this.repoPath(`/releases/tags/${encodeURIComponent(tag)}`)}`, { headers: this.headers() }, "release lookup");
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, "release lookup");
    return (await res.json()) as Release;
  }

  private async ensureRelease(tag: string, title: string): Promise<Release> {
    const existing = await this.getRelease(tag);
    if (existing) return existing;
    const res = await this.call(
      `${this.apiUrl}${this.repoPath("/releases")}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          tag_name: tag,
          name: title,
          body: `Artifacts of the Splice package ${title}. Managed by the Splice registry; verify downloads against the SHA-256 recorded in the registry.`,
          draft: false,
          prerelease: false,
          make_latest: "false",
        }),
      },
      "release creation",
    );
    if (res.status === 422) {
      // Created concurrently by another publish.
      const again = await this.getRelease(tag);
      if (again) return again;
    }
    if (!res.ok) await this.fail(res, "release creation");
    return (await res.json()) as Release;
  }

  private async listAssets(release: Release): Promise<ReleaseAsset[]> {
    const assets: ReleaseAsset[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.call(
        `${this.apiUrl}${this.repoPath(`/releases/${release.id}/assets?per_page=100&page=${page}`)}`,
        { headers: this.headers() },
        "asset listing",
      );
      if (!res.ok) await this.fail(res, "asset listing");
      const batch = (await res.json()) as ReleaseAsset[];
      assets.push(...batch);
      if (batch.length < 100) break;
    }
    return assets;
  }

  private async downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    // The API redirects to a signed URL; fetch follows it and drops the Authorization header
    // on the cross-origin hop.
    const res = await this.call(
      `${this.apiUrl}${this.repoPath(`/releases/assets/${asset.id}`)}`,
      { headers: this.headers({ accept: "application/octet-stream" }) },
      "asset download",
    );
    if (!res.ok) await this.fail(res, "asset download");
    return new Uint8Array(await res.arrayBuffer());
  }

  private async deleteAsset(asset: ReleaseAsset): Promise<void> {
    const res = await this.call(`${this.apiUrl}${this.repoPath(`/releases/assets/${asset.id}`)}`, { method: "DELETE", headers: this.headers() }, "asset deletion");
    if (!res.ok && res.status !== 404) await this.fail(res, "asset deletion");
  }

  private async sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async assetMatches(asset: ReleaseAsset, sha256: string): Promise<boolean> {
    if (asset.digest) return asset.digest.toLowerCase() === `sha256:${sha256}`;
    return (await this.sha256Hex(await this.downloadAsset(asset))) === sha256;
  }

  async put(key: string, bytes: Uint8Array, options: ArtifactPutOptions): Promise<StoredArtifact> {
    const { tag, assetName, release: title } = this.locate(key);
    if (options.sha256 !== this.locate(key).sha256) throw new ArtifactStoreError("Artifact key does not match its SHA-256");
    const release = await this.ensureRelease(tag, title);

    const existing = (await this.listAssets(release)).find((a) => a.name === assetName);
    if (existing) {
      if (await this.assetMatches(existing, options.sha256)) {
        // Idempotent retry: a previous publish uploaded these exact bytes (e.g. the D1 write failed).
        return { url: existing.browser_download_url };
      }
      // Never overwrite a stored artifact: a version's bytes are immutable once uploaded, even if the
      // registry metadata write failed. Publish a new version instead.
      throw new ArtifactStoreError(`An artifact for ${assetName} already exists with different content`, 409);
    }

    const res = await this.call(
      `${this.uploadUrl}${this.repoPath(`/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`)}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": options.contentType, "content-length": String(bytes.byteLength) }),
        body: bytes as Uint8Array<ArrayBuffer>,
      },
      "asset upload",
    );
    if (!res.ok) await this.fail(res, "asset upload");
    const asset = (await res.json()) as ReleaseAsset;
    if (asset.size !== bytes.byteLength || (asset.digest && asset.digest.toLowerCase() !== `sha256:${options.sha256}`)) {
      await this.deleteAsset(asset).catch(() => {});
      throw new ArtifactStoreError("GitHub stored different bytes than were uploaded");
    }
    return { url: asset.browser_download_url };
  }

  async get(key: string, location?: StoredArtifact): Promise<Uint8Array | null> {
    const { tag, assetName } = this.locate(key);
    // Public repositories: one unauthenticated request to the recorded download URL.
    if (location?.url?.startsWith("https://")) {
      try {
        const res = await this.fetchImpl(location.url, { headers: { "user-agent": "splice-registry" } });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
      } catch {
        // fall back to the API (private repositories, transient errors)
      }
    }
    const release = await this.getRelease(tag);
    if (!release) return null;
    const asset = (await this.listAssets(release)).find((a) => a.name === assetName);
    return asset ? this.downloadAsset(asset) : null;
  }
}
