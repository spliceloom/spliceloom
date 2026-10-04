import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createRegistryHandler } from "./handler.js";
import { createSqliteDatabase } from "./node.js";
import { MemoryRateLimiter } from "./ratelimit.js";
import { RegistryService } from "./service.js";
import { GITHUB_LOGIN_PATTERN, githubIdentity, type GitHubAccount, type GitHubIdentity } from "./signup.js";
import { MemoryArtifactStore } from "./storage.js";

describe("self-service sign-up (GitHub gist)", () => {
  let now = Date.parse("2026-10-04T12:00:00Z");
  const accounts = new Map<string, GitHubAccount>();
  let reachable = true;
  const identity: GitHubIdentity = {
    async lookup(login) {
      if (!reachable) throw new Error("down");
      return accounts.get(login.toLowerCase()) ?? null;
    },
  };
  const account = (login: string, over: Partial<GitHubAccount> = {}): GitHubAccount => ({ login, type: "User", createdAt: "2020-01-01T00:00:00Z", gistDescriptions: [], ...over });
  let service: RegistryService;
  let handle: (request: Request) => Promise<Response>;
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await handle(new Request(`http://registry.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  /** Signs `login` up: start, publish the code in a gist, verify. */
  const signUp = async (login: string) => {
    const start = await post("/signup/start", { github: login });
    accounts.set(login.toLowerCase(), account(login, { gistDescriptions: ["notes", `my code ${start.body.code}`] }));
    return post("/signup/verify", { github: login, code: start.body.code });
  };

  before(async () => {
    const db = createSqliteDatabase(":memory:");
    service = new RegistryService(db, new MemoryArtifactStore(), () => new Date(now));
    handle = createRegistryHandler({ service, identity });
    // An account an admin created, and a reserved namespace.
    await service.createUser("dim");
    await service.setNamespaceOwner("dim", "dim");
  });
  after(() => service.close());

  it("accepts GitHub logins and nothing that could be a path or a pattern", () => {
    for (const ok of ["octocat", "Octo-Cat", "a", "a1-b2"]) assert.ok(GITHUB_LOGIN_PATTERN.test(ok), ok);
    for (const bad of ["", "-a", "a-", "a--b", "a/b", "a b", "../x", "a".repeat(40)]) assert.ok(!GITHUB_LOGIN_PATTERN.test(bad), bad);
  });

  it("gives a verified account its own namespace and a token limited to it", async () => {
    const start = await post("/signup/start", { github: "Octocat" });
    assert.equal(start.status, 200);
    assert.equal(start.body.namespace, "octocat");
    assert.match(start.body.code, /^splice-signup-[0-9a-f]{24}$/);
    assert.equal(start.headers.get("access-control-allow-origin"), "*");

    // Not verified until the code is in a public gist of that account.
    accounts.set("octocat", account("Octocat"));
    const early = await post("/signup/verify", { github: "octocat", code: start.body.code });
    assert.equal(early.status, 400);
    assert.equal(early.body.error.code, "VERIFICATION_FAILED");

    accounts.set("octocat", account("Octocat", { gistDescriptions: [start.body.code] }));
    const done = await post("/signup/verify", { github: "octocat", code: start.body.code });
    assert.equal(done.status, 201);
    assert.equal(done.body.user, "octocat");
    assert.deepEqual(done.body.namespaces, ["octocat"]);
    assert.match(done.body.token, /^splice_/);
    const ns = await service.getNamespace("octocat");
    assert.equal(ns.owner, "octocat");

    // The code is single-use.
    assert.equal((await post("/signup/verify", { github: "octocat", code: start.body.code })).status, 400);
  });

  it("issues tokens that cannot reach other namespaces, directly or through a new token", async () => {
    const { body } = await signUp("builder");
    const user = (await service.authenticate(body.token))!;
    assert.deepEqual(user.token!.namespaces, ["builder"]);
    await assert.rejects(service.createUserToken(user, { namespaces: ["openai"] }), /may only create tokens for: @builder/);
    const child = await service.createUserToken(user, {});
    assert.deepEqual(child.namespaces, ["builder"]);
    assert.equal(child.canManage, false);
    const wide = await handle(new Request("http://registry.test/auth/tokens", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${body.token}` }, body: JSON.stringify({ namespaces: ["dim"] }) }));
    assert.equal(wide.status, 403);
  });

  it("never hands over an account or namespace that belongs to someone else", async () => {
    // "dim" was created by an admin: a GitHub user with that login cannot sign up into it.
    assert.equal((await post("/signup/start", { github: "dim" })).status, 409);
    // A namespace owned by another account.
    await service.setNamespaceOwner("taken", "dim");
    assert.equal((await post("/signup/start", { github: "taken" })).status, 403);
    // Taken between start and verify: still refused, and no account is created.
    const start = await post("/signup/start", { github: "racer" });
    await service.setNamespaceOwner("racer", "dim");
    accounts.set("racer", account("racer", { gistDescriptions: [start.body.code] }));
    assert.equal((await post("/signup/verify", { github: "racer", code: start.body.code })).status, 403);
    assert.equal(await service.getUser("racer"), null);
    // A code issued for one login does not work for another.
    const mine = await post("/signup/start", { github: "mallory" });
    accounts.set("victim", account("victim", { gistDescriptions: [mine.body.code] }));
    assert.equal((await post("/signup/verify", { github: "victim", code: mine.body.code })).status, 400);
  });

  it("refuses organizations, new accounts, unknown users and expired codes", async () => {
    const check = async (login: string, over: Partial<GitHubAccount>, pattern: RegExp) => {
      const start = await post("/signup/start", { github: login });
      accounts.set(login, account(login, { gistDescriptions: [start.body.code], ...over }));
      const r = await post("/signup/verify", { github: login, code: start.body.code });
      assert.equal(r.status, 400, login);
      assert.match(r.body.error.message, pattern);
    };
    await check("some-org", { type: "Organization" }, /personal GitHub accounts/);
    await check("newbie", { createdAt: "2026-09-20T00:00:00Z" }, /at least 30 days old/);
    const ghost = await post("/signup/start", { github: "ghost-user" });
    assert.match((await post("/signup/verify", { github: "ghost-user", code: ghost.body.code })).body.error.message, /no user/);
    const late = await post("/signup/start", { github: "slowpoke" });
    accounts.set("slowpoke", account("slowpoke", { gistDescriptions: [late.body.code] }));
    now += 31 * 60_000;
    assert.match((await post("/signup/verify", { github: "slowpoke", code: late.body.code })).body.error.message, /expired/);
    assert.equal((await post("/signup/start", { github: "not a login" })).status, 400);
  });

  it("lets a signed-up account get a new token by proving the same GitHub account again", async () => {
    const first = await signUp("returning");
    const second = await signUp("returning");
    assert.equal(second.status, 201);
    assert.notEqual(second.body.token, first.body.token);
    assert.equal((await service.authenticate(first.body.token))!.id, (await service.authenticate(second.body.token))!.id);
  });

  it("reports GitHub outages as temporary, is rate limited, and is off without an identity reader", async () => {
    const start = await post("/signup/start", { github: "patient" });
    reachable = false;
    assert.equal((await post("/signup/verify", { github: "patient", code: start.body.code })).status, 503);
    reachable = true;
    const limited = createRegistryHandler({ service, identity, rateLimits: { signup: new MemoryRateLimiter(1, 60_000) } });
    const call = () => limited(new Request("http://registry.test/signup/start", { method: "POST", body: JSON.stringify({ github: "limited" }) }));
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429);
    const off = await createRegistryHandler({ service })(new Request("http://registry.test/signup/start", { method: "POST", body: JSON.stringify({ github: "x" }) }));
    assert.equal(off.status, 503);
  });

  it("reads only the account's own public gists from GitHub", async () => {
    const seen: string[] = [];
    const reader = githubIdentity({
      token: "t",
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
        if (url.endsWith("/users/octocat")) return Response.json({ login: "octocat", type: "User", created_at: "2011-01-25T18:44:36Z" });
        if (url.includes("/users/octocat/gists")) return Response.json([{ description: "mine", public: true, owner: { login: "Octocat" } }, { description: "secret", public: false, owner: { login: "octocat" } }, { description: "theirs", public: true, owner: { login: "other" } }, { description: null, public: true, owner: { login: "octocat" } }]);
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    assert.deepEqual(await reader.lookup("octocat"), { login: "octocat", type: "User", createdAt: "2011-01-25T18:44:36Z", gistDescriptions: ["mine"] });
    assert.equal(await reader.lookup("nobody"), null);
    assert.equal(await reader.lookup("../admin"), null);
    assert.deepEqual(seen.slice(0, 2), ["https://api.github.com/users/octocat Bearer t", "https://api.github.com/users/octocat/gists?per_page=30 Bearer t"]);
  });
});
