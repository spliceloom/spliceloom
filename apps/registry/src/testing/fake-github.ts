/**
 * In-memory fake of the GitHub Releases API subset used by GitHubReleaseArtifactStore, for tests.
 * Mirrors the real behaviour that matters: bearer auth, release-by-tag lookup, 422 on duplicate
 * tags/asset names, paginated asset listing, uploads with a server-computed `digest`, a 302 redirect
 * to a signed download URL, public browser_download_url, and injectable failures.
 * Not used in production.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  digest: string;
  contentType: string;
  bytes: Uint8Array;
  releaseId: number;
}

interface FakeRelease {
  id: number;
  tag_name: string;
  name: string;
}

export interface FakeFailure {
  /** Substring of "METHOD /path". */
  match: string;
  status: number;
  /** How many requests to fail (default 1). */
  times?: number;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class FakeGitHub {
  readonly releases: FakeRelease[] = [];
  readonly assets: FakeAsset[] = [];
  readonly requests: string[] = [];
  failures: FakeFailure[] = [];
  /** Simulates a repository without commits (release creation fails like on GitHub). */
  emptyRepository = false;
  /** Omit `digest` from asset JSON (older GitHub behaviour). */
  omitDigest = false;
  uploads = 0;
  private nextId = 1;

  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly token: string,
    public baseUrl = "http://fake-github.test",
  ) {}

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private assetJson(a: FakeAsset): Record<string, unknown> {
    const release = this.releases.find((r) => r.id === a.releaseId)!;
    const json: Record<string, unknown> = {
      id: a.id,
      name: a.name,
      size: a.size,
      content_type: a.contentType,
      browser_download_url: `${this.baseUrl}/${this.owner}/${this.repo}/releases/download/${encodeURIComponent(release.tag_name)}/${a.name}`,
    };
    if (!this.omitDigest) json.digest = a.digest;
    return json;
  }

  /** Fetch-compatible handler. */
  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const label = `${method} ${url.pathname}${url.search}`;
    this.requests.push(label);

    const failure = this.failures.find((f) => label.includes(f.match));
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.times <= 0) this.failures = this.failures.filter((f) => f !== failure);
      return this.json({ message: "Injected failure" }, failure.status);
    }

    // Unauthenticated routes: public and signed downloads.
    const download = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && download) {
      const tag = decodeURIComponent(download[3]!);
      const release = this.releases.find((r) => r.tag_name === tag);
      const asset = this.assets.find((a) => a.releaseId === release?.id && a.name === download[4]);
      return asset ? new Response(asset.bytes as Uint8Array<ArrayBuffer>) : new Response("Not Found", { status: 404 });
    }
    const signed = /^\/signed\/(\d+)$/.exec(url.pathname);
    if (method === "GET" && signed) {
      const asset = this.assets.find((a) => a.id === Number(signed[1]));
      return asset ? new Response(asset.bytes as Uint8Array<ArrayBuffer>) : new Response("Not Found", { status: 404 });
    }

    if (request.headers.get("authorization") !== `Bearer ${this.token}`) return this.json({ message: "Bad credentials" }, 401);
    if (!request.headers.get("user-agent")) return this.json({ message: "User-Agent required" }, 403);
    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!url.pathname.startsWith(prefix)) return this.json({ message: "Not Found" }, 404);
    const path = url.pathname.slice(prefix.length);

    const byTag = /^\/releases\/tags\/(.+)$/.exec(path);
    if (method === "GET" && byTag) {
      const release = this.releases.find((r) => r.tag_name === decodeURIComponent(byTag[1]!));
      return release ? this.json(release) : this.json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && path === "/releases") {
      const body = (await request.json()) as { tag_name: string; name: string };
      if (this.emptyRepository) return this.json({ message: "Repository is empty." }, 422);
      if (this.releases.some((r) => r.tag_name === body.tag_name)) return this.json({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, 422);
      const release = { id: this.nextId++, tag_name: body.tag_name, name: body.name };
      this.releases.push(release);
      return this.json(release, 201);
    }
    const list = /^\/releases\/(\d+)\/assets$/.exec(path);
    if (method === "GET" && list) {
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = this.assets.filter((a) => a.releaseId === Number(list[1]));
      return this.json(all.slice((page - 1) * perPage, page * perPage).map((a) => this.assetJson(a)));
    }
    if (method === "POST" && list) {
      const name = url.searchParams.get("name") ?? "";
      const releaseId = Number(list[1]);
      if (!this.releases.some((r) => r.id === releaseId)) return this.json({ message: "Not Found" }, 404);
      if (this.assets.some((a) => a.releaseId === releaseId && a.name === name)) {
        return this.json({ message: "Validation Failed", errors: [{ code: "already_exists", field: "name" }] }, 422);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const asset: FakeAsset = {
        id: this.nextId++,
        name,
        size: bytes.byteLength,
        digest: `sha256:${await sha256(bytes)}`,
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
        bytes,
        releaseId,
      };
      this.assets.push(asset);
      this.uploads++;
      return this.json(this.assetJson(asset), 201);
    }
    const one = /^\/releases\/assets\/(\d+)$/.exec(path);
    if (one) {
      const asset = this.assets.find((a) => a.id === Number(one[1]));
      if (!asset) return this.json({ message: "Not Found" }, 404);
      if (method === "DELETE") {
        this.assets.splice(this.assets.indexOf(asset), 1);
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && request.headers.get("accept") === "application/octet-stream") {
        return new Response(null, { status: 302, headers: { location: `${this.baseUrl}/signed/${asset.id}` } });
      }
      if (method === "GET") return this.json(this.assetJson(asset));
    }
    return this.json({ message: "Not Found" }, 404);
  };

  /** fetch() for in-process tests: follows redirects and drops Authorization cross-origin like browsers/undici. */
  fetch: typeof fetch = async (input, init) => {
    let response = await this.handle(input as string, init);
    let hops = 0;
    while (response.status === 302 && hops++ < 3) {
      response = await this.handle(response.headers.get("location")!, { method: "GET" });
    }
    return response;
  };

  /** Serves the fake over HTTP (for the Worker running in workerd). */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const init: RequestInit = { method: req.method ?? "GET", headers };
      if (chunks.length > 0) init.body = new Uint8Array(Buffer.concat(chunks)) as Uint8Array<ArrayBuffer>;
      const response = await this.handle(`${this.baseUrl}${req.url}`, init);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      url: this.baseUrl,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}
