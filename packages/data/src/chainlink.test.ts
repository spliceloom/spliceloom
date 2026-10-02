import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { SpliceData } from "./services.js";
import { decodeReport, fixed18, schemaVersion } from "./providers/chainlink.js";

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const E18 = 10n ** 18n;

/** abi.encode(bytes32[3] context, bytes blob, bytes32[] rs, bytes32[] ss, bytes32 rawVs) with empty rs/ss. */
function envelope(blobWords: bigint[]): string {
  const blob = blobWords.map(word).join("");
  const head = [1n, 2n, 3n, 7n * 32n, 0n, 0n, 0n].map(word); // context×3, blob offset, rs offset, ss offset, rawVs
  const blobLen = word(BigInt(blob.length / 2));
  return `0x${head.join("")}${blobLen}${blob}${word(0n)}${word(0n)}`;
}

const ETH_FEED = 0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9n;
const TSLA_FEED = 0x000b2dbed1640ead18d37338b75e4755630a900649261baf4ed79d9a749be13dn;

describe("Chainlink Data Streams decoding", () => {
  it("reads the schema version from the feed id", () => {
    assert.equal(schemaVersion("0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9"), 3);
    assert.equal(schemaVersion("0x000b2dbed1640ead18d37338b75e4755630a900649261baf4ed79d9a749be13d"), 11);
  });

  it("formats 18-decimal fixed point exactly", () => {
    assert.equal(fixed18(2703n * E18 + 4n * 10n ** 17n), "2703.4");
    assert.equal(fixed18(-15n * 10n ** 17n), "-1.5");
    assert.equal(fixed18(0n), "0");
  });

  it("decodes a v3 (crypto) report", () => {
    const r = decodeReport(envelope([ETH_FEED, 1_790_899_800n, 1_790_899_810n, 1n, 2n, 1_790_903_410n, 2703n * E18 + 4n * 10n ** 17n, 2703n * E18, 2704n * E18]));
    assert.equal(r.schemaVersion, 3);
    assert.equal(r.price, "2703.4");
    assert.equal(r.bid, "2703");
    assert.equal(r.ask, "2704");
    assert.equal(r.observedAt, "2026-10-02T00:10:10.000Z");
  });

  it("decodes a v11 (US equities) report with market status", () => {
    const r = decodeReport(envelope([TSLA_FEED, 1_790_899_800n, 1_790_899_810n, 0n, 0n, 1_790_903_410n, 25012n * 10n ** 16n, 1_790_899_809_000_000_000n, 250n * E18, 1000n * E18, 2502n * 10n ** 17n, 900n * E18, 25011n * 10n ** 16n, 2n]));
    assert.equal(r.schemaVersion, 11);
    assert.equal(r.price, "250.12");
    assert.equal(r.bid, "250");
    assert.equal(r.ask, "250.2");
    assert.equal(r.lastTradedPrice, "250.11");
    assert.equal(r.marketStatus, "regular");
    assert.equal(r.lastSeen, "2026-10-02T00:10:09.000Z");
  });

  it("refuses truncated reports and unknown schemas instead of guessing", () => {
    assert.throws(() => decodeReport(envelope([ETH_FEED, 1n, 2n])), /shorter than its schema/);
    assert.throws(() => decodeReport(envelope([0x0005n << 240n, 1n, 2n, 3n, 4n, 5n, 6n])), /schema v5 is not decoded/);
  });

  it("Candlestick: logs in once, unscales 1e18 candles, and backs oracle prices when streams are not subscribed", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      if (url.endsWith("/api/v1/authorize")) return Response.json({ s: "ok", d: { access_token: "jwt-abc", expiration: Math.floor(Date.now() / 1000) + 3600 } });
      if (url.includes("/api/v1/history") && url.includes("symbol=TSLAUSD")) return Response.json({ s: "ok", t: [1790964000, 1790960400], o: [3.7217e20, 3.7e20], h: [3.73e20, 3.72e20], l: [3.71e20, 3.69e20], c: [3.7138e20, 3.7217e20] });
      if (url.includes("/api/v1/history")) return Response.json({ s: "error", errmsg: "Not found - Could not find feedID for symbol" }, { status: 404 });
      if (url.includes("/reports/latest")) return Response.json({ error: "feeds not authorized" }, { status: 401 });
      if (url.includes("/api/v1/discovery")) return Response.json({ feeds: [{ feedId: "0x000b2dbed1640ead18d37338b75e4755630a900649261baf4ed79d9a749be13d", baseAsset: "TSLA", quoteAsset: "USD", assetClass: "Equities", attributeType: "RegularHoursEquityPrice", status: "live", networkType: "mainnet" }] });
      return new Response("not mocked", { status: 500 });
    };
    const data = new SpliceData({ env: { CHAINLINK_DATA_STREAMS_API_KEY: "user-1", CHAINLINK_DATA_STREAMS_HMAC_SECRET: "s", CHAINLINK_CANDLESTICK_USER: "user-1", CHAINLINK_CANDLESTICK_API_KEY: "candle-pass" }, envFile: null, fetch });
    const candles = await data.oracle.candles("tsla", { timeframe: "1h", limit: 2 });
    assert.ok(candles.status === "LIVE", JSON.stringify(candles));
    assert.deepEqual(candles.data.candles.map((c) => c.close), ["372.17", "371.38"], "sorted oldest first, unscaled");
    const login = seen.find((s) => s.url.endsWith("/authorize"))!;
    assert.equal(String(login.init?.body), "login=user-1&password=candle-pass");
    assert.equal((seen.find((s) => s.url.includes("/history"))!.init?.headers as Record<string, string>).authorization, "Bearer jwt-abc");
    const price = await data.oracle.price("TSLA");
    assert.ok(price.status === "LIVE", JSON.stringify(price));
    assert.equal((price.data as { price: string; source: string }).price, "371.38");
    assert.equal((price.data as { source: string }).source, "candlestick");
    assert.match(price.provenance.notes!.join(" "), /latest 1-minute Chainlink Candlestick candle.*not subscribed/);
    assert.equal(seen.filter((s) => s.url.endsWith("/authorize")).length, 1, "the JWT is reused");
    const missing = await data.oracle.candles("NOPE");
    assert.equal(missing.status, "UNAVAILABLE");
    assert.equal((await data.oracle.candles("TSLA", { timeframe: "2h" })).status, "ERROR");
    assert.doesNotMatch(JSON.stringify([candles, price, missing]), /candle-pass|jwt-abc/);
  });

  it("signs report requests with HMAC-SHA256 over method, path, body hash, key and timestamp", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/reports/latest")) return new Response(JSON.stringify({ error: "feeds not authorized" }), { status: 401 });
      return new Response(JSON.stringify({ feeds: [{ feedId: "0x000b2dbed1640ead18d37338b75e4755630a900649261baf4ed79d9a749be13d", baseAsset: "TSLA", quoteAsset: "USD", assetClass: "Equities", attributeType: "RegularHoursEquityPrice", status: "live", networkType: "mainnet", isSubscribed: false }] }), { status: 200 });
    };
    const data = new SpliceData({ env: { CHAINLINK_DATA_STREAMS_API_KEY: "key-123", CHAINLINK_DATA_STREAMS_HMAC_SECRET: "secret-456" }, envFile: null, fetch });
    const result = await data.oracle.price("TSLA");
    assert.equal(result.status, "UNAVAILABLE");
    assert.match(JSON.stringify(result), /not subscribed to the feed/);
    const req = seen.find((s) => s.url.includes("/reports/latest"))!;
    const ts = req.headers["x-authorization-timestamp"]!;
    const path = "/api/v1/reports/latest?feedID=0x000b2dbed1640ead18d37338b75e4755630a900649261baf4ed79d9a749be13d";
    const expected = createHmac("sha256", "secret-456").update(`GET ${path} ${createHash("sha256").update("").digest("hex")} key-123 ${ts}`).digest("hex");
    assert.equal(req.headers.authorization, "key-123");
    assert.equal(req.headers["x-authorization-signature-sha256"], expected);
    assert.doesNotMatch(JSON.stringify(result), /secret-456/);
  });
});
