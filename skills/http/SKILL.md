# @splice/http

HTTP client for agents: `GET` and `POST` to **public** http(s) URLs with a timeout, a response
size limit and structured results.

**Permissions: `network: ["*"]` — any public host.** Installing needs `--accept-permissions`.
The Splice sandbox refuses every non-public target, whatever URL the tool is given:

- loopback and `localhost` (`127.0.0.0/8`, `::1`, `*.localhost`),
- private networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), CGNAT (`100.64/10`),
- link-local incl. cloud metadata (`169.254.0.0/16`, e.g. `169.254.169.254`, `fe80::/10`),
- multicast, reserved, documentation and IPv4-mapped/NAT64/6to4 ranges,
- host names that *resolve* to any of the above, and
- redirects to any of the above (every redirect hop is checked again).

No file system access and no environment variables: the tool cannot read or send local secrets.

## When should an agent use this skill?

- Fetch a public JSON API or web page (`http.get`).
- Submit data to a public API that needs no credentials (`http.post`).

Not for authenticated APIs: `Authorization` and `Cookie` headers cannot be sent (by design).

## Tools

### `http.get`

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | absolute http(s) URL, max 2048 chars, no `user:pass@` |
| `headers` | object | no | only `accept`, `accept-language`, `if-none-match`, `if-modified-since`, `user-agent` |
| `timeoutMs` | integer 100–15000 | no | default 10000, for the complete response |
| `maxBytes` | integer 1–524288 | no | default 262144; larger responses fail |
| `responseType` | `auto` \| `json` \| `text` | no | default `auto` |

### `http.post`

Same as `get`, plus exactly one body: `json` (any value, sent as `application/json`) or `text`
(string, max 1,000,000 chars) with optional `contentType`.

### Output (both)

```json
{
  "url": "https://…final URL…", "status": 200, "statusText": "OK", "ok": true, "redirected": false,
  "headers": { "content-type": "application/json", "etag": "…" },
  "bodyType": "json", "json": { … }, "bytes": 1234
}
```

- `bodyType`: `json` (parsed into `json`), `text` (`text`), `base64` (non-text content, `base64`) or `empty`.
- Returned headers are limited to `content-type`, `content-length`, `etag`, `last-modified`,
  `cache-control`, `date`, `location`, `retry-after`. `Set-Cookie` is never returned.
- HTTP error statuses (4xx/5xx) are results with `ok: false`, not failures.

### Errors

| Message prefix | Meaning |
| --- | --- |
| `INVALID_URL:` | not an absolute http(s) URL, or contains credentials |
| `TIMEOUT:` | no complete response within `timeoutMs` |
| `RESPONSE_TOO_LARGE:` | body larger than `maxBytes` |
| `NETWORK_ERROR:` | DNS failure, connection refused, TLS error, too many redirects |
| `INVALID_JSON_RESPONSE:` | `responseType: "json"` but the body is not JSON |
| `INVALID_INPUT:` | both `json` and `text` given |
| runtime `PERMISSION_DENIED` | the target is not a public address (see above) |

## Examples

```sh
splice run http.get url=https://api.github.com/repos/spliceloom/splice-artifacts
splice run http.post --input '{"url":"https://httpbin.org/post","json":{"hello":"splice"}}'
```

See `examples/`. Compose with `@splice/json` (`json.pick`) to keep only the fields you need.

## Limitations

The private-address check resolves DNS before connecting; the connection itself resolves again,
so a hostile DNS server answering differently within milliseconds (DNS rebinding) is not fully
prevented. The network guard runs inside the tool process (Node.js has no network permission
flag); see the Splice permissions documentation.
