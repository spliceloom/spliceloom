/**
 * Unit tests for @splice/http against a local HTTP server (outside the sandbox, so localhost is
 * reachable here). Run with: node --test tests/*.test.ts
 * The sandbox rules — private/local targets refused, redirects re-checked, permission denial —
 * are covered by the Splice repository's integration tests, which run this package in the runtime.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import get from "../tools/get.ts";
import post from "../tools/post.ts";

describe("@splice/http", () => {
  let server: Server;
  let base: string;
  let lastRequest: { method?: string; headers: Record<string, unknown>; body: string } = { headers: {}, body: "" };

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        lastRequest = { method: req.method, headers: req.headers, body };
        const path = req.url ?? "/";
        if (path === "/json") return res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=secret", etag: '"v1"' }).end('{"hello":"world","n":[1,2]}');
        if (path === "/text") return res.writeHead(200, { "content-type": "text/plain" }).end("plain text");
        if (path === "/binary") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        if (path === "/empty") return res.writeHead(204).end();
        if (path === "/not-json") return res.writeHead(200, { "content-type": "application/json" }).end("{nope");
        if (path === "/missing") return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        if (path === "/big-declared") return res.writeHead(200, { "content-type": "text/plain", "content-length": "2000" }).end("x".repeat(2000));
        if (path === "/big-streamed") {
          res.writeHead(200, { "content-type": "text/plain" });
          for (let i = 0; i < 20; i++) res.write("y".repeat(100));
          return res.end();
        }
        if (path === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000);
        if (path === "/redirect") return res.writeHead(302, { location: "/json" }).end();
        if (path === "/echo") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, contentType: req.headers["content-type"], body }));
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("GETs JSON, parses it and returns only safe response headers", async () => {
    const r = await get({ url: `${base}/json` });
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.bodyType, "json");
    assert.deepEqual(r.json, { hello: "world", n: [1, 2] });
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers.etag, '"v1"');
    assert.equal("set-cookie" in r.headers, false, "cookies are never returned");
    assert.equal(r.bytes, 27);
    assert.match(String(lastRequest.headers["user-agent"]), /^splice-http\/0\.1\.0/);
  });

  it("returns text, base64 and empty bodies", async () => {
    assert.deepEqual([(await get({ url: `${base}/text` })).bodyType, (await get({ url: `${base}/text` })).text], ["text", "plain text"]);
    const bin = await get({ url: `${base}/binary` });
    assert.deepEqual([bin.bodyType, bin.base64], ["base64", "iVBORw=="]);
    assert.deepEqual((await get({ url: `${base}/empty` })).bodyType, "empty");
    assert.equal((await get({ url: `${base}/json`, responseType: "text" })).text, '{"hello":"world","n":[1,2]}');
  });

  it("reports HTTP errors as data (status/ok), not exceptions", async () => {
    const r = await get({ url: `${base}/missing` });
    assert.equal(r.status, 404);
    assert.equal(r.ok, false);
    assert.deepEqual(r.json, { error: "not found" });
  });

  it("follows redirects and reports the final URL", async () => {
    const r = await get({ url: `${base}/redirect` });
    assert.equal(r.url, `${base}/json`);
    assert.equal(r.redirected, true);
  });

  it("forwards only the allowed request headers", async () => {
    await get({ url: `${base}/json`, headers: { accept: "application/json", "accept-language": "id" } });
    assert.equal(lastRequest.headers.accept, "application/json");
    assert.equal(lastRequest.headers["accept-language"], "id");
    await get({ url: `${base}/json`, headers: { authorization: "Bearer stolen" } as never });
    assert.equal(lastRequest.headers.authorization, undefined);
  });

  it("rejects invalid URLs", async () => {
    for (const url of ["not a url", "/relative/path", "ftp://example.com/file", "file:///etc/passwd", "https://user:pass@example.com/"]) {
      await assert.rejects(get({ url }), /^Error: INVALID_URL: /, url);
    }
  });

  it("times out", async () => {
    const started = Date.now();
    await assert.rejects(get({ url: `${base}/slow`, timeoutMs: 200 }), /^Error: TIMEOUT: no complete response within 200 ms/);
    assert.ok(Date.now() - started < 1500);
  });

  it("refuses oversized responses (declared and streamed)", async () => {
    await assert.rejects(get({ url: `${base}/big-declared`, maxBytes: 1000 }), /^Error: RESPONSE_TOO_LARGE: response is 2000 bytes/);
    await assert.rejects(get({ url: `${base}/big-streamed`, maxBytes: 1000 }), /^Error: RESPONSE_TOO_LARGE: response exceeded 1000 bytes/);
    assert.equal((await get({ url: `${base}/big-streamed`, maxBytes: 5000 })).bytes, 2000);
  });

  it("reports network failures", async () => {
    await assert.rejects(get({ url: "http://127.0.0.1:9/" }), /^Error: NETWORK_ERROR: /);
  });

  it("fails clearly when JSON was required but the body is not JSON", async () => {
    await assert.rejects(get({ url: `${base}/not-json`, responseType: "json" }), /^Error: INVALID_JSON_RESPONSE: /);
    assert.equal((await get({ url: `${base}/not-json` })).bodyType, "text", "auto falls back to text");
  });

  it("POSTs JSON and text bodies", async () => {
    const json = await post({ url: `${base}/echo`, json: { a: 1 } });
    assert.deepEqual(json.json, { method: "POST", contentType: "application/json", body: '{"a":1}' });
    const text = await post({ url: `${base}/echo`, text: "a=1", contentType: "application/x-www-form-urlencoded" });
    assert.deepEqual(text.json, { method: "POST", contentType: "application/x-www-form-urlencoded", body: "a=1" });
    await assert.rejects(post({ url: `${base}/echo`, json: {}, text: "x" }), /^Error: INVALID_INPUT: /);
  });

  it("keeps sandbox permission denials as they are (not network errors)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Object.assign(new Error('Network access to "10.0.0.1" is denied'), { code: "ERR_ACCESS_DENIED" });
    };
    try {
      await assert.rejects(get({ url: "http://10.0.0.1/" }), (e: unknown) => (e as { code?: string }).code === "ERR_ACCESS_DENIED");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
