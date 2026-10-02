# Security model, boundaries and limits

What Splice enforces, how, and what it does **not** guarantee. Written to be precise rather than
reassuring; see [permissions.md](permissions.md) for the permission syntax and
[trust.md](trust.md) for package verification.

## Summary

| Area | Enforced by | Guarantee | Not guaranteed |
| --- | --- | --- | --- |
| File access | Node.js permission model (`--permission`, `--allow-fs-read/write`) | a tool can only open declared project paths and its own package | Node follows symlinks; skills taking caller paths must check real paths (`@splice/files` does) |
| Child processes, workers, addons, WASI, inspector, `eval` | Node.js permission model / flags | denied | — |
| Network | in-process guard in the tool host (Node 24 has no network permission) | only declared hosts; non-public addresses refused at connection time; redirects re-checked | not an OS firewall (see [Network](#network)) |
| Environment | tool processes start with an empty environment | only declared variables | a tool given a secret can use it |
| Installed code | SHA-256 at install + files digest re-checked at load | modified installed files are never executed | someone who can rewrite both the files *and* splice.lock controls the project anyway |
| Tool I/O | runtime | input ≤ 4 MiB and ≤ 256 levels deep, schema-validated before a process starts; output ≤ 1 MiB, schema-validated | — |

## Integrity is not authenticity

Splice distinguishes two properties, and currently guarantees only the first:

- **Artifact integrity** — the bytes you install are exactly the bytes the registry recorded at
  publish time. Enforced: SHA-256 and size checked before extraction, versions immutable, lock
  pins, files digest re-checked before loading.
- **Publisher authenticity** — cryptographic proof of *who* produced those bytes. **Not
  provided.** Packages are not signed. The registry records provenance (the account and token
  type that published, the time, artifact and manifest hashes), which tells you what the registry
  observed; it is not a signature and is only as trustworthy as the registry and the publisher's
  account security. `splice verify` reports the signature check as "skipped: unsigned".

Treat installed skills as code you trust at the level of their publisher, and review the
permissions they request.

## Network

Tools get exactly one networking API: a `fetch()` provided by the host
(`packages/runtime/src/net-policy.ts`), built on `node:http`/`node:https`.

For every request and every redirect hop:

1. Protocol `http:`/`https:` only; URLs with `user:password@` are refused.
2. The host must match a declared pattern (`api.github.com`, `*.example.com`, or `*`).
3. IP literals must be public; `localhost` / `*.localhost` names are refused.
4. **The address check runs inside the socket's DNS lookup.** Every address the name resolves to
   must be public, and the connection uses exactly the addresses that were checked — there is no
   separate "check" resolution followed by an unchecked "connect" resolution. A DNS server that
   changes its answer (DNS rebinding) cannot make the connection reach an address that was not
   validated.
5. Redirects are followed by the guard (max 5), each hop re-checked; cross-origin hops drop
   `Authorization`, `Cookie` and `Proxy-Authorization`; `303` (and `301/302` after `POST`) become `GET`.

Refused ranges — IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (incl. metadata
`169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`,
`198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4` (reserved, incl.
broadcast). IPv6: `::`, `::1`, `::ffff:0:0/96` (IPv4-mapped), `::/96` (IPv4-compatible),
`64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), `100::/64`, `2001::/23`, `2001:db8::/32`,
`2002::/16` (6to4), `3fff::/20`, `5f00::/16`, `fc00::/7` (unique local), `fe80::/10`
(link-local), `fec0::/10`, `ff00::/8` (multicast). Exception: a package that declares that exact
IP literal or `localhost` (an explicit, reviewable grant shown at install).

### What the guard removes from tools

Tools cannot import `node:net`, `node:http`, `node:https`, `node:http2`, `node:tls`,
`node:dgram`, `node:dns`, `node:inspector` or `node:module` — not via `import`, `require`
(`createRequire` lives in `node:module`) or `process.getBuiltinModule()`, which the host replaces
with a denying wrapper. `WebSocket`, `EventSource` and the built-in fetch's dispatcher
(`Symbol.for("undici.globalDispatcher.1")`) are removed; `fetch`, `getBuiltinModule` and those
globals are locked (non-writable, non-configurable). `process.binding` is denied by Node.

Phase 8 found and closed three bypasses of the earlier guard: `process.getBuiltinModule("net")`,
`registerHooks` from `node:module` (re-resolving `node:net`) and the global undici dispatcher.
Regression tests cover each (`packages/runtime/src/runtime.test.ts`).

These protections live in the Splice runtime (client side), not in the skill package: they apply
to every package, including the already published `@splice/http@0.1.0`, whose SKILL.md predates
Phase 8 and still describes the older check-then-connect limitation.

### Residual limitations (network)

- **In-process control.** Node.js 24 has no network permission flag, so the guard relies on tools
  having no other way to create sockets. The known ways are removed and tested; a future Node
  release adding a new socket API would need to be handled here. It is not an OS-level firewall
  or a network namespace. If that matters, run agents on hosts whose own firewall blocks internal
  ranges.
- `@splice/http` (`network: ["*"]`) can reach **any public** host: an agent with it can send data
  it has to the internet. That is the capability; grant it deliberately.
- Name resolution uses the operating system resolver (hosts file included); a hosts-file entry
  pointing a name at a private address is refused like any other private answer.

## Files (`@splice/files`)

Declared paths are the hard boundary (Node permission model: `workspace/` only). Inside it:

- absolute paths, drive letters, UNC paths (`//server/share`, `//?/…`), `..` → `PATH_OUTSIDE_SANDBOX`;
- backslashes, NUL/control characters, empty or `.` segments, > 512 characters → `INVALID_PATH`;
- **Windows semantics, refused on every platform** (fail closed): reserved device names (`CON`,
  `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, `CONIN$`, `CONOUT$`, any extension), trailing dots or
  spaces (Windows strips them: `.env.` would open `.env`), `:` (NTFS alternate data streams such
  as `a.txt:secret`), 8.3 short-name aliases (`SECRET~1.YAM`), `< > " | ? *`;
- symbolic links **and junctions / reparse points** are never followed: every existing path is
  resolved with `realpath` and must stay inside the real workspace; links are listed but not opened;
- **hard links**: a file with more than one link is refused (`HARD_LINK`), because a hard link
  to a file outside the workspace is indistinguishable from a normal file by path;
- after opening, the descriptor is checked again: regular file, single link, same device/inode as
  the in-workspace real path;
- credential-like names (`.env*`, private keys, `.ssh`, `.aws`, `.npmrc`, `.netrc`, `credentials*`,
  `secret(s)*`, …) → `SENSITIVE_PATH`, hidden from listings.

Residual limitation: an attacker process that can modify the workspace **concurrently** could
race a directory swap between the final check and the creation of a *new* file (Node has no
portable `openat`/`O_NOFOLLOW`). Existing files are verified through the opened descriptor before
any byte is read or written.

## Installed code and supply chain

- Artifacts are verified before anything is extracted: SHA-256 and size against registry
  metadata, archive safety, package validity, manifest vs. metadata ([trust.md](trust.md)).
- Locked versions must match the lock's SHA-256 and size (`LOCK_MISMATCH`, fail closed).
- **Files digest (Phase 8):** `splice.lock` records a digest of the extracted files. The SDK, the
  CLI (`splice run`) and MCP re-check it before loading a package; modified, added (hidden files
  included) or removed files → `INSTALLED_PACKAGE_MODIFIED`, the package is not executed and not
  exposed over MCP. `splice install` restores the verified copy. Lock entries written before
  Phase 8 have no digest and are not checked (reinstall to add it).
- Published versions are immutable (registry, artifact store and D1 triggers); provenance is
  write-once.

## MCP

- Only packages installed in the project **and** passing the files-digest and permission-grant
  checks are exposed; tool schemas are the manifests' own.
- Input is size/depth-limited and schema-validated by the runtime before a tool process starts.
- Tool errors, logs and load errors are returned with secrets redacted and absolute
  package/project paths replaced by `<package>` / `<project>`.
- stdio: lines longer than 4 MiB are discarded while streaming (never buffered whole).
  Streamable HTTP (`splice mcp --http`): bearer token required (≥ 24 chars), request bodies
  ≤ 1 MiB, `Origin` headers refused, loopback by default.
- The registry's `/mcp` requires a registry token and never executes skills.

## Secret hygiene

- Registry tokens are stored hashed server-side; locally in `~/.splice/credentials.json` (0600).
  Only `splice token create` prints a token (once, to stdout).
- Tool processes receive no environment except declared variables.
- `redactSecrets` (`@spliceloom/spec`) removes well-known token formats (Splice, GitHub, OpenAI/
  Anthropic-style, Slack, AWS key ids, Google API keys, JWTs), `Authorization`/`Cookie` values, PEM
  private keys, credentials in URLs and secret-named `KEY=value` pairs. It is applied to runtime
  error messages and tool logs (plus the exact values of the tool's declared environment
  variables), CLI error output, MCP tool errors and the registry Worker's error logs.
- It is pattern-based: it cannot recognize arbitrary secrets. Do not give tools secrets they do
  not need.

## Live data providers

- Provider keys are read only from a fixed list of provider variables (process env, then the
  nearest `.env.local` / `.env`, else `~/.splice/.env`); no other variable in those files is read
  ([data-providers.md](data-providers.md#configuration)).
- Every provider error is redacted of the exact configured values, including keys embedded in RPC
  URL paths and query strings; endpoints are displayed as templates. The live integration tests
  fail if a key appears in any result.
- Provider requests use the same network guard as skills (`createGuardedFetch`): a per-provider
  host allowlist, DNS-time address checks, re-checked redirects, size and time limits. TLS is
  never disabled — a provider behind TLS interception is reported as `degraded`.
- Data tools in MCP are opt-in (`--data`), read-only and schema-validated.
- Skills reach host capabilities only through the capability broker ([capabilities.md](capabilities.md)):
  the host checks every call against the declared and granted `permissions.capabilities` (also
  when the IPC channel is used directly), limits calls (25 per execution, 4 concurrent), argument
  size (256 KiB, 32 levels) and result size (4 MiB), validates arguments per capability, and runs
  the call with its own keys. The tool process keeps its empty environment and network guard.
- AI, GitHub and market providers use the same mechanism: OpenRouter may reach only
  `openrouter.ai`, Gemini only `generativelanguage.googleapis.com`, GitHub only `api.github.com`,
  raw files only `raw.githubusercontent.com` (URL validated: https, exact host, no port,
  credentials, query or traversal), DexScreener only `api.dexscreener.com`, GeckoTerminal only
  `api.geckoterminal.com`, Tavily / Exa / Firecrawl only `api.tavily.com` / `api.exa.ai` /
  `api.firecrawl.dev`. The GitHub token is sent only to `api.github.com`.
- Web providers fetch pages on their side. Target URLs are checked with the same rule as skills
  with `network: ["*"]` (public http(s) hosts only; no localhost, private, link-local, metadata,
  `.local`/`.internal` hosts or credentials), so a provider is never asked to fetch an internal
  address. Web content is untrusted third-party text and is labelled so in MCP.
- GitHub access is read-only (no write endpoint is implemented). AI calls are validated (message,
  size, token, tool and image limits) before they are sent; AI results are never cached.
- `npm run secret-scan` checks the repository, build output and staged npm package for configured
  credential values and known key formats.

## Resource limits

| Limit | Value | Where |
| --- | --- | --- |
| Tool input | 4 MiB serialized, 256 levels deep | runtime (`INPUT_TOO_LARGE`, before validation/spawn) |
| Tool output | 1 MiB serialized | runtime (`OUTPUT_TOO_LARGE`) |
| Tool logs kept | 64 KiB | runtime |
| Tool timeout | manifest `timeoutMs` (default 10 s, max 60 s) | runtime (process killed) |
| MCP stdio line | 4 MiB | `serveStdio` |
| MCP HTTP body | 1 MiB | `handleMcpHttp` |
| `http.get/post` response | 256 KiB default, 512 KiB max (`maxBytes`), enforced while streaming | `@splice/http` |
| `http.post` body | `text` ≤ 1,000,000 chars; `json` within the 4 MiB input limit | `@splice/http` |
| `http` timeout | 10 s default, 15 s max (`timeoutMs`); tool timeout 20 s | `@splice/http` |
| `json.parse` text | 1,000,000 chars, 256 levels deep | `@splice/json` |
| `json.pick` | 100 paths × 512 chars | `@splice/json` |
| `files.read` | 256 KiB default, 512 KiB max (`maxBytes`), bounded even if the file grows | `@splice/files` |
| `files.write` | 1 MiB decoded | `@splice/files` |
| `files.list` | 2000 entries, depth 16 | `@splice/files` |
| GitHub responses | 1 MiB, 10 s | `@splice/github` |
| Package artifact | 5 MiB, 500 files; 2 MiB per file | spec / registry |

## Windows specifics

- Development and tests run on Windows 11. Junctions are created without privileges and are
  tested; file symlinks need Developer Mode or admin rights, so that test is skipped when they
  cannot be created (it runs on POSIX CI and privileged Windows).
- Hard links on NTFS are tested (`HARD_LINK`).
- Path rules above (reserved names, trailing dots/spaces, ADS, 8.3, UNC, drive letters) apply on
  every platform so that a package behaves the same everywhere.
- Runtime error messages replace both `C:\…` and `file:///C:/…` forms of package/project paths.
- `npm.ps1` may be blocked by PowerShell's execution policy; use `npm.cmd`. No application code
  works around it.

## GitHub API (`@splice/github`)

Anonymous only: public data, about 60 requests/hour per IP (search: about 10/minute). No token
mechanism is offered on purpose — the package declares no environment variables, so it cannot
read one, and asking users to put tokens into packages is refused by design. Results include the
rate-limit headers; exhaustion → `RATE_LIMITED` with the reset time.
