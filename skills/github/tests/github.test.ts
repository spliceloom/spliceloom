/**
 * Unit tests for @splice/github with a stubbed fetch (no real GitHub calls, no token).
 * Run with: node --test tests/*.test.ts
 * Permission enforcement (api.github.com only) is covered by the Splice repository's integration
 * tests, which run this package in the sandbox.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkOwner, checkRepo } from "../lib/github.ts";
import getRepo from "../tools/get-repo.ts";
import listRepos from "../tools/list-repos.ts";
import searchRepositories from "../tools/search-repositories.ts";

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Headers }> = [];

function stub(handler: (url: URL) => Response | Promise<Response>): void {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    return handler(url);
  }) as typeof fetch;
}

const limits = { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1790000000" };
const json = (body: unknown, status = 200, headers: Record<string, string> = limits) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rawRepo = {
  full_name: "spliceloom/splice-artifacts",
  name: "splice-artifacts",
  owner: { login: "spliceloom", id: 1 },
  description: "Artifacts",
  html_url: "https://github.com/spliceloom/splice-artifacts",
  homepage: "",
  default_branch: "main",
  language: null,
  license: { spdx_id: "MIT" },
  topics: ["agents"],
  stargazers_count: 3,
  forks_count: 1,
  open_issues_count: 0,
  archived: false,
  fork: false,
  private: false,
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  pushed_at: "2026-10-01T00:00:00Z",
};

describe("@splice/github", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("looks up a public repository (anonymous, api.github.com only)", async () => {
    stub(() => json(rawRepo));
    const r = await getRepo({ owner: "spliceloom", repo: "splice-artifacts" });
    assert.deepEqual(r.repository, {
      fullName: "spliceloom/splice-artifacts",
      name: "splice-artifacts",
      owner: "spliceloom",
      description: "Artifacts",
      url: "https://github.com/spliceloom/splice-artifacts",
      homepage: null,
      defaultBranch: "main",
      language: null,
      license: "MIT",
      topics: ["agents"],
      stars: 3,
      forks: 1,
      openIssues: 0,
      archived: false,
      fork: false,
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      pushedAt: "2026-10-01T00:00:00Z",
    });
    assert.deepEqual(r.rateLimit, { limit: 60, remaining: 59, resetAt: "2026-09-21T14:13:20.000Z" });
    assert.equal(calls[0]!.url, "https://api.github.com/repos/spliceloom/splice-artifacts");
    assert.equal(calls[0]!.headers.get("authorization"), null, "never authenticated");
    assert.equal(calls[0]!.headers.get("accept"), "application/vnd.github+json");
  });

  it("lists repositories and searches with GitHub query syntax", async () => {
    stub((url) => (url.pathname.startsWith("/search") ? json({ total_count: 42, incomplete_results: false, items: [rawRepo] }) : json([rawRepo, rawRepo])));
    const listed = await listRepos({ owner: "spliceloom", perPage: 2 });
    assert.equal(listed.repositories.length, 2);
    assert.equal(listed.hasMore, true);
    assert.equal(calls[0]!.url, "https://api.github.com/users/spliceloom/repos?type=owner&sort=updated&per_page=2&page=1");

    const found = await searchRepositories({ query: "mcp language:typescript", sort: "stars", perPage: 5 });
    assert.equal(found.totalCount, 42);
    assert.equal(found.repositories[0]!.fullName, "spliceloom/splice-artifacts");
    const searched = new URL(calls.at(-1)!.url);
    assert.equal(searched.origin + searched.pathname, "https://api.github.com/search/repositories");
    assert.equal(searched.searchParams.get("q"), "mcp language:typescript");
    assert.equal(searched.searchParams.get("sort"), "stars");
  });

  it("rejects invalid input before any request", async () => {
    stub(() => json(rawRepo));
    for (const [owner, repo] of [["-bad", "x"], ["a b", "x"], ["ok", "../../etc"], ["ok", ".."], ["ok", "a/b"], ["x".repeat(40), "r"]]) {
      await assert.rejects(getRepo({ owner: owner!, repo: repo! }), /^Error: INVALID_INPUT: /, `${owner}/${repo}`);
    }
    await assert.rejects(searchRepositories({ query: "   " }), /^Error: INVALID_INPUT: /);
    assert.equal(calls.length, 0);
    assert.doesNotThrow(() => checkOwner("octo-cat"));
    assert.doesNotThrow(() => checkRepo("splice.js_v2-x"));
  });

  it("maps GitHub errors: not found, rate limit, validation", async () => {
    stub(() => json({ message: "Not Found" }, 404));
    await assert.rejects(getRepo({ owner: "nobody-here", repo: "none" }), /^Error: NOT_FOUND: not found \(or not public\)/);
    stub(() => json({ message: "API rate limit exceeded" }, 403, { ...limits, "x-ratelimit-remaining": "0" }));
    await assert.rejects(getRepo({ owner: "a", repo: "b" }), /^Error: RATE_LIMITED: the anonymous GitHub API limit \(60 requests\/hour\)/);
    stub(() => json({ message: "Validation Failed" }, 422));
    await assert.rejects(searchRepositories({ query: "x" }), /^Error: INVALID_INPUT: GitHub rejected the request/);
    stub(() => json({ message: "boom" }, 500));
    await assert.rejects(getRepo({ owner: "a", repo: "b" }), /^Error: GITHUB_ERROR: GitHub returned HTTP 500/);
  });

  it("reports network failures and timeouts", async () => {
    stub(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
    });
    await assert.rejects(getRepo({ owner: "a", repo: "b" }), /^Error: NETWORK_ERROR: could not reach GitHub: fetch failed \(getaddrinfo ENOTFOUND/);
    stub(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await assert.rejects(getRepo({ owner: "a", repo: "b" }), /^Error: TIMEOUT: /);
  });

  it("keeps sandbox permission denials as they are", async () => {
    stub(() => {
      throw Object.assign(new Error('Network access to "api.github.com" is denied'), { code: "ERR_ACCESS_DENIED" });
    });
    await assert.rejects(getRepo({ owner: "a", repo: "b" }), (e: unknown) => (e as { code?: string }).code === "ERR_ACCESS_DENIED");
  });
});
