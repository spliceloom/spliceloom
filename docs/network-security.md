# Network security

Splice uses one network guard for sandboxed tools and for every provider request the host makes.

## What the guard checks

For each `fetch()` — and again for every redirect hop, which the guard follows itself:

1. **Declared host.** The hostname must match the package's `network` list (`api.github.com`,
   `*.example.com`) or `*` for any public host. Each provider has its own fixed host allowlist
   (e.g. Alchemy only its RPC host, GitHub only `api.github.com`).
2. **Public address.** Private (10/8, 172.16/12, 192.168/16), loopback, link-local, cloud metadata
   (169.254.169.254), CGNAT, multicast, reserved ranges, IPv6 equivalents and IPv4-mapped or
   -compatible IPv6 forms are refused — unless that exact IP literal (or `localhost`) is declared.
3. **At connection time.** The address is validated inside the socket's DNS lookup, so the address
   that is checked is the address that is connected to (DNS rebinding is closed). One non-public
   answer is enough to refuse.
4. **TLS.** Certificates are always verified; there is no option to disable it.

Responses are size- and time-limited (5 MiB and 15 seconds by default for providers).

## SSRF through providers

Web providers (Tavily, Exa, Firecrawl) fetch pages on their own servers. Splice still refuses to ask
them for non-public targets: URLs must be public http(s) hosts — no localhost, private, link-local,
metadata or `.local`/`.internal` names, and no credentials in the URL.

## Provider isolation

Provider keys are read only from their environment variables, live only in the host process, are
sent only to their provider's host and are redacted (including keys embedded in RPC URL paths) from
every result, error and log. Sandboxed skills never receive them.

## Limitations

The guard runs inside Node.js: it removes every API Node offers to open sockets from tool processes
and is covered by tests, but it is not a kernel-level firewall. See
[security model](security.md) for the complete list of residual risks.
