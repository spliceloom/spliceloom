import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { checkNetworkTarget, checkResolvedAddresses, createCheckedLookup, createGuardedFetch, isNonPublicAddress, MAX_REDIRECTS } from "./net-policy.js";

const denied = (m: string) => Object.assign(new Error(m), { code: "ERR_ACCESS_DENIED" });
const isDenied = (pattern: RegExp) => (e: unknown) => (e as { code?: string }).code === "ERR_ACCESS_DENIED" && pattern.test((e as Error).message);

describe("network policy", () => {
  describe("address classification (IPv4 and IPv6)", () => {
    it("refuses every non-public IPv4 range", () => {
      for (const a of ["0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) {
        assert.equal(isNonPublicAddress(a), true, a);
      }
      for (const a of ["8.8.8.8", "1.1.1.1", "140.82.112.6", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.0", "169.253.0.1", "11.0.0.1", "223.255.255.254"]) assert.equal(isNonPublicAddress(a), false, a);
    });

    it("refuses every non-public IPv6 range, including IPv4-mapped/compatible forms", () => {
      for (const a of ["::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "5f00::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff05::2"]) {
        assert.equal(isNonPublicAddress(a), true, a);
      }
      for (const a of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::200e", "2620:0:862:ed1a::1"]) assert.equal(isNonPublicAddress(a), false, a);
      assert.equal(isNonPublicAddress("not-an-ip"), true);
    });
  });

  describe("target checks", () => {
    const check = (url: string, patterns: string[]) => checkNetworkTarget(new URL(url), patterns);

    it("requires a declared host, http(s) and no embedded credentials", () => {
      assert.deepEqual(check("https://api.github.com/x", ["api.github.com"]), { allowed: true, explicit: false });
      assert.deepEqual(check("https://a.example.com/", ["*.example.com"]), { allowed: true, explicit: false });
      assert.equal(check("https://example.com/", ["*.example.com"]).allowed, false, "*.example.com does not cover the apex");
      assert.equal(check("https://evil.com/", ["api.github.com"]).allowed, false);
      for (const url of ["ftp://api.github.com/", "file:///etc/passwd", "https://u:p@api.github.com/", "https://u@api.github.com/"]) assert.equal(check(url, ["api.github.com"]).allowed, false, url);
    });

    it('"*" refuses private/loopback IP literals and localhost names in every notation', () => {
      for (const url of ["http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://[::1]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://169.254.169.254/", "http://[fe80::1]/", "http://[fd00::1]/", "http://10.0.0.1/", "http://localhost/", "http://LOCALHOST./", "http://api.localhost/", "http://0.0.0.0/"]) {
        const d = check(url, ["*"]);
        assert.equal(d.allowed, false, url);
        assert.match(!d.allowed ? d.reason : "", /not a public address/, url);
      }
      assert.deepEqual(check("http://8.8.8.8/", ["*"]), { allowed: true, explicit: false });
    });

    it("an explicitly declared IP literal or localhost is an explicit grant for that exact host", () => {
      assert.deepEqual(check("http://127.0.0.1:8080/", ["127.0.0.1"]), { allowed: true, explicit: true });
      assert.deepEqual(check("http://localhost:8080/", ["localhost"]), { allowed: true, explicit: true });
      assert.equal(check("http://127.0.0.2/", ["127.0.0.1"]).allowed, false);
      assert.equal(check("http://[::1]/", ["127.0.0.1"]).allowed, false);
    });

    it("resolved addresses must all be public (one private answer is enough to refuse)", () => {
      assert.deepEqual(checkResolvedAddresses("a.example", ["93.184.215.14", "2606:2800::1"], false), { allowed: true });
      const mixed = checkResolvedAddresses("rebind.example", ["93.184.215.14", "10.0.0.5"], false);
      assert.match(!mixed.allowed ? mixed.reason : "", /10\.0\.0\.5 \(resolved from rebind\.example\) is not a public address/);
      assert.equal(checkResolvedAddresses("x", [], false).allowed, false);
      assert.deepEqual(checkResolvedAddresses("localhost", ["127.0.0.1"], true), { allowed: true });
    });
  });

  describe("guarded fetch (real connections)", () => {
    let server: Server;
    let port: number;
    before(async () => {
      server = createServer((req, res) => {
        const path = req.url ?? "/";
        if (path === "/ok") return res.writeHead(200, { "content-type": "application/json", "x-dup": "a" }).end('{"ok":true}');
        if (path === "/gzip") return res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(gzipSync("compressed body"));
        if (path === "/echo") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c));
          return req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null, type: req.headers["content-type"] ?? null })));
        }
        if (path === "/hop") return res.writeHead(302, { location: "/ok" }).end();
        if (path === "/post-303") return res.writeHead(303, { location: "/echo" }).end();
        if (path === "/to-localhost") return res.writeHead(302, { location: `http://localhost:${port}/ok` }).end();
        if (path === "/to-127") return res.writeHead(301, { location: `http://127.0.0.2:${port}/ok` }).end();
        if (path === "/to-metadata") return res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        if (path === "/to-ipv6") return res.writeHead(308, { location: `http://[::1]:${port}/ok` }).end();
        if (path === "/to-mapped") return res.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${port}/ok` }).end();
        if (path === "/to-private-name") return res.writeHead(302, { location: `http://internal.example:${port}/ok` }).end();
        if (path === "/to-file") return res.writeHead(302, { location: "file:///etc/passwd" }).end();
        if (path === "/loop") return res.writeHead(302, { location: "/loop" }).end();
        if (path === "/no-content") return res.writeHead(204).end();
        if (path === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000);
        if (path === "/cross") return res.writeHead(302, { location: `http://public.example:${port}/echo` }).end();
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    after(() => {
      server.closeAllConnections();
      server.close();
    });

    /** Fake DNS: every name maps to a list of answers served in turn (to simulate rebinding). */
    function dns(table: Record<string, string[][]>) {
      const calls: string[] = [];
      const turn: Record<string, number> = {};
      const lookupAll = async (host: string) => {
        calls.push(host);
        const answers = table[host];
        if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
        const i = Math.min(turn[host] ?? 0, answers.length - 1);
        turn[host] = i + 1;
        return answers[i]!;
      };
      return { lookupAll, calls };
    }

    it("performs requests with the checked lookup (one resolution per connection)", async () => {
      const { lookupAll, calls } = dns({ localhost: [["127.0.0.1"]] });
      const f = createGuardedFetch(["localhost"], lookupAll, denied);
      const res = await f(`http://localhost:${port}/ok`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(res.url, `http://localhost:${port}/ok`);
      assert.equal(res.redirected, false);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.deepEqual(calls, ["localhost"], "the connection used the checked lookup, and only once");
      assert.equal(await (await f(`http://localhost:${port}/gzip`)).text(), "compressed body");
      assert.equal((await f(`http://localhost:${port}/no-content`)).status, 204);
      const posted = await (await f(`http://localhost:${port}/echo`, { method: "POST", body: "a=1", headers: { authorization: "Bearer t" } })).json();
      assert.deepEqual(posted, { method: "POST", body: "a=1", auth: "Bearer t", type: "text/plain;charset=UTF-8" });
    });

    it("DNS rebinding: the lookup the socket uses is the one that is validated", async () => {
      // A rebinding DNS server answers public first, private second. A check-then-connect design
      // would validate answer 1 and connect with answer 2. Here the socket's own lookup is the
      // check: it hands the connection exactly the address it validated, and refuses answer 2.
      const { lookupAll, calls } = dns({ "rebind.example": [["93.184.215.14"], ["127.0.0.1"]] });
      const lookup = createCheckedLookup(lookupAll, false, denied);
      const first = await new Promise<[unknown, unknown]>((r) => lookup("rebind.example", { all: true }, (err, address) => r([err, address])));
      assert.deepEqual(first, [null, [{ address: "93.184.215.14", family: 4 }]]);
      const second = await new Promise<unknown>((r) => lookup("rebind.example", {}, (err) => r(err)));
      assert.match((second as Error).message, /127\.0\.0\.1 \(resolved from rebind\.example\) is not a public address/);
      assert.equal((second as { code?: string }).code, "ERR_ACCESS_DENIED");
      assert.deepEqual(calls, ["rebind.example", "rebind.example"]);
      // End to end: a refused answer fails the request before any byte is sent.
      await assert.rejects(createGuardedFetch(["*"], dns({ "rebind.example": [["127.0.0.1"]] }).lookupAll, denied)(`http://rebind.example:${port}/ok`), isDenied(/127\.0\.0\.1 \(resolved from rebind\.example\)/));
    });

    it("refuses names that resolve to private addresses, even when declared", async () => {
      const { lookupAll } = dns({ "api.example.com": [["192.168.1.10"]], "dual.example": [["93.184.215.14", "::1"]] });
      await assert.rejects(createGuardedFetch(["api.example.com"], lookupAll, denied)(`http://api.example.com:${port}/ok`), isDenied(/192\.168\.1\.10/));
      await assert.rejects(createGuardedFetch(["*"], lookupAll, denied)(`http://dual.example:${port}/ok`), isDenied(/::1 \(resolved from dual\.example\)/));
    });

    it("refuses private IP literals before connecting", async () => {
      const { lookupAll, calls } = dns({});
      const f = createGuardedFetch(["*"], lookupAll, denied);
      for (const url of [`http://127.0.0.1:${port}/ok`, `http://[::1]:${port}/ok`, "http://169.254.169.254/", "http://10.0.0.1/"]) {
        await assert.rejects(f(url), isDenied(/not a public address/), url);
      }
      assert.deepEqual(calls, []);
    });

    it("follows allowed redirects and re-checks every hop", async () => {
      const { lookupAll } = dns({ localhost: [["127.0.0.1"]], "internal.example": [["10.1.1.1"]], "public.example": [["127.0.0.1"]] });
      const f = createGuardedFetch(["localhost", "127.0.0.1"], lookupAll, denied);
      const hop = await f(`http://localhost:${port}/hop`);
      assert.equal(hop.url, `http://localhost:${port}/ok`);
      assert.equal(hop.redirected, true);
      for (const [path, reason] of [
        ["/to-127", /Redirect blocked: Network access to "127\.0\.0\.2" is denied/],
        ["/to-metadata", /Redirect blocked: .*169\.254\.169\.254/],
        ["/to-ipv6", /Redirect blocked: .*"::1"/],
        ["/to-mapped", /Redirect blocked: .*::ffff:/],
        ["/to-private-name", /Redirect blocked: Network access to "internal\.example" is denied/],
        ["/to-file", /Redirect blocked: fetch\(\) to protocol "file:"/],
      ] as const) {
        await assert.rejects(f(`http://127.0.0.1:${port}${path}`), isDenied(reason), path);
      }
      // "*" (the @splice/http permission) never reaches localhost, not even via redirect.
      const star = createGuardedFetch(["*"], dns({ "a.example": [["127.0.0.1"]] }).lookupAll, denied);
      await assert.rejects(star(`http://a.example:${port}/to-localhost`), isDenied(/not a public address/));
      await assert.rejects(f(`http://localhost:${port}/loop`), new RegExp(`more than ${MAX_REDIRECTS} redirects`));
    });

    it("303 turns POST into GET, and credentials never cross origins", async () => {
      const { lookupAll } = dns({ localhost: [["127.0.0.1"]], "public.example": [["127.0.0.1"]] });
      const f = createGuardedFetch(["localhost", "public.example"], lookupAll, denied);
      const r = (await (await f(`http://localhost:${port}/post-303`, { method: "POST", body: "x" })).json()) as { method: string; body: string };
      assert.deepEqual([r.method, r.body], ["GET", ""]);
      // public.example is declared (hostname, not literal), so its private answer is refused:
      await assert.rejects(f(`http://localhost:${port}/cross`, { headers: { authorization: "Bearer secret" } }), isDenied(/public\.example/));
    });

    it("honours abort signals and timeouts", async () => {
      const f = createGuardedFetch(["localhost"], dns({ localhost: [["127.0.0.1"]] }).lookupAll, denied);
      await assert.rejects(f(`http://localhost:${port}/slow`, { signal: AbortSignal.timeout(150) }), (e: unknown) => (e as Error).name === "TimeoutError");
    });

    it("reports DNS failures as network errors, not permission denials", async () => {
      const f = createGuardedFetch(["*"], dns({}).lookupAll, denied);
      await assert.rejects(f("http://nowhere.example/"), (e: unknown) => e instanceof TypeError && /fetch failed/.test(e.message));
    });
  });
});
