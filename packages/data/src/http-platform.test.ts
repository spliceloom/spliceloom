import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostLockedFetch, type FetchLike } from "./http.js";

describe("hostLockedFetch (platform fetch, e.g. Cloudflare Workers)", () => {
  const seen: string[] = [];
  const base: FetchLike = async (url) => {
    seen.push(url);
    if (url === "https://api.example.com/redirect-ok") return new Response(null, { status: 302, headers: { location: "/final" } });
    if (url === "https://api.example.com/redirect-out") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    return new Response("ok", { status: 200 });
  };
  const locked = hostLockedFetch(["api.example.com"], base);

  it("allows HTTPS requests to listed hosts and follows same-host redirects", async () => {
    assert.equal(await (await locked("https://api.example.com/x")).text(), "ok");
    assert.equal((await locked("https://api.example.com/redirect-ok")).status, 200);
    assert.ok(seen.includes("https://api.example.com/final"));
  });

  it("refuses other hosts, plain HTTP and redirects that leave the allowlist", async () => {
    await assert.rejects(locked("https://evil.example.com/"), /not allowed/);
    await assert.rejects(locked("http://api.example.com/"), /not allowed/);
    await assert.rejects(locked("https://api.example.com/redirect-out"), /not allowed/);
  });
});
