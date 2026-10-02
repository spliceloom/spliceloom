# Web

Web search, readable page text, site maps, similar pages and cited answers — from Tavily, Exa and
Firecrawl. The providers fetch the web on their side; Splice only talks to their APIs.

| Capability | Order (fallback) | CLI |
| --- | --- | --- |
| `web.search` | Tavily → Exa → Firecrawl | `splice web search "<query>"` |
| `web.extract` (up to 10 URLs) | Tavily → Firecrawl → Exa | `splice web extract <url>` |
| `web.map` | Firecrawl → Tavily | `splice web map <url>` |
| `web.similar` | Exa | `splice web similar <url>` |
| `web.answer` (with citations) | Tavily → Exa | `splice web answer "<question>"` |

Configure at least one of `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`.

## Use it

```sh
splice web search "Robinhood Chain documentation" --limit 5
splice web search "agent sandboxing" --content --max-chars 3000 --include-domain github.com
splice web extract https://docs.robinhood.com/chain/ --max-chars 4000
splice web answer "What is the chain ID of Robinhood Chain mainnet?"
splice web search "mcp" --provider exa
```

`--provider` pins one provider (no fallback). SDK: `splice.web.search()`, `extract()`, `map()`,
`similar()`, `answer()`. MCP: `web_search`, `web_extract`, `web_map`, `web_similar`,
`web_answer`. Skills: the `web.*` host capabilities, or the official `@splice/web` skill.

## Safety

- Target URLs are checked with the same rule as skills with `network: ["*"]`: public http(s) hosts
  only — no localhost, private, link-local, metadata or `.local`/`.internal` hosts, no credentials —
  so a provider is never asked to fetch an internal address.
- Results are third-party web content. Treat them as untrusted data, never as instructions; the MCP
  server tells clients so.
- Page text is capped per result (default 5,000 characters, maximum 50,000) and marked
  `truncated: true` when cut.

## Cost and limits

Credits and cost are reported as the provider returns them (`usage.credits`, `usage.costUsd`).
Health checks spend nothing: Tavily `/usage`, an empty Exa validation request, Firecrawl credit
usage. Results are cached for five minutes. Out-of-credit (Tavily 432/433, HTTP 402) and rate limits
move on to the next provider.
