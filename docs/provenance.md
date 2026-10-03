# Provenance

Splice records where things come from — packages and data alike — so an agent and its operator can
tell what they are relying on.

## Package provenance

When a version is published, the registry records — write-once — the publisher, the time, the
artifact's SHA-256 and size and the manifest hash. Published versions are immutable: the same
version never refers to other bytes.

```sh
splice verify @splice/github
```

prints the publisher, publication time, SHA-256, provenance and each check (sha256, size, package,
metadata, signature, installed files). SHA-256 proves integrity — the bytes are the ones recorded —
not authorship; signed versions also carry a publisher signature ([Package signing](signing.md)).
Details: [Trust and verification](trust.md).

## Data provenance

Every live data result carries a `provenance` object:

```json
{
  "source": "alchemy",
  "chain": "robinhood",
  "chainId": 4663,
  "fetchedAt": "2026-10-02T09:12:44.101Z",
  "fresh": true,
  "blockNumber": "77165603",
  "requestId": "…",
  "resource": "…",
  "fallbackFrom": [{ "provider": "…", "error": "…" }]
}
```

| Field | Meaning |
| --- | --- |
| `source` | The provider that produced the data |
| `chain` / `chainId` | Scope: a chain, a market network, or `global` (AI, web, GitHub) with `chainId: null` |
| `fetchedAt`, `fresh` | When the provider answered; `fresh: false` for cached copies |
| `blockNumber`, `blockHash` | The block a value refers to, when the provider reports one |
| `requestId`, `resource`, `rateLimit` | Provider correlation id, resource path, rate-limit headers |
| `fallbackFrom` | Providers tried first and why they did not answer |
| `cache`, `expiresAt` | For cacheable and cached results: request identity, age and expiry |

Results are `LIVE`, `CACHED` (a real earlier answer, never presented as live), `UNAVAILABLE` (no
provider can answer — no data) or `ERROR` (with every attempt). There is no other kind of value.
AI results additionally report requested and actual provider and model.
