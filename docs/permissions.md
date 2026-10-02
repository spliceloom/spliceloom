# Permissions

Every Splice package declares what it may touch in `manifest.json` → `permissions`. Everything
else is denied by the runtime, whatever the tool code tries. Installing a package that declares
anything needs explicit consent (`--accept-permissions`), and the grant is recorded in
`splice.lock` ([trust.md](trust.md#permissions-and-consent)).

```json
"permissions": {
  "fs": { "read": ["workspace"], "write": ["workspace"] },
  "network": ["api.github.com"],
  "env": []
}
```

| Permission | Values | Enforced by |
| --- | --- | --- |
| `fs.read` / `fs.write` | project-relative paths without `..` (`.` = whole project) | Node.js permission model (`--allow-fs-read/write`) |
| `network` | host names (`api.github.com`), wildcards (`*.example.com`), or `*` = any **public** host | in-process network guard (see below) |
| `env` | variable names (`UPPER_SNAKE_CASE`) | the tool process starts with an empty environment plus these |
| `capabilities` | host capabilities (`web.search`, `market.price`, `onchain.balance`, …) | checked by the host for every `ctx.capability()` call; run by the host with its own keys ([capabilities.md](capabilities.md)) |

A package's own install directory is always readable. Child processes, worker threads, native
addons, WASI, the inspector and `eval` are always denied.

## Official skills

| Package | Declares | Effect |
| --- | --- | --- |
| `@splice/json` | nothing | no files, no network, no environment |
| `@splice/http` | `network: ["*"]` | any public host; non-public targets refused |
| `@splice/files` | `fs.read/write: ["workspace"]` | only `<project>/workspace/` |
| `@splice/github` | `network: ["api.github.com"]` | that host only; no token |
| `@splice/web`, `@splice/market`, `@splice/onchain` | `capabilities` only | no network, no environment; host capabilities through the broker |

The integration tests replace these tool implementations with code that tries to read `.env`,
fetch another host or spawn a process, and check that the runtime refuses: a package never gains
a permission because its code attempts to use it.

## Network rules

For every `fetch()` — and for every redirect hop, which the runtime follows itself — the guard
checks:

1. Protocol `http:` or `https:`; no `user:password@` in the URL.
2. The host matches a declared pattern (`*` matches every host).
3. The target is a public address. Refused (unless that exact IP literal or `localhost` is
   declared, which is an explicit, reviewable grant):
   - loopback `127.0.0.0/8`, `::1`, `localhost`, `*.localhost`
   - private `10/8`, `172.16/12`, `192.168/16`, unique-local `fc00::/7`
   - link-local `169.254/16` (cloud metadata such as `169.254.169.254`), `fe80::/10`
   - CGNAT `100.64/10`, `0/8`, multicast, reserved, benchmarking and documentation ranges
   - IPv4-mapped (`::ffff:0:0/96`), NAT64, 6to4 and other IPv6 transition ranges
   - host names that **resolve** to any of these (all DNS answers are checked)
4. Cross-origin redirects drop `Authorization`, `Cookie` and `Proxy-Authorization` headers; at
   most 5 redirects.

Raw sockets (`node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram`, `node:dns`, …),
`WebSocket` and `EventSource` are unavailable to tools.

A declared name that resolves to a private address is refused too — `network: ["api.example.com"]`
does not allow reaching an internal service through DNS.

Since Phase 8 the address check runs inside the socket's own DNS lookup (the connection uses
exactly the validated addresses), and the other socket APIs Node offers are removed from tools.
Details: [security.md](security.md#network).

### Limitations

- The guard runs inside the tool process: Node.js 24 has no network permission flag. It is not
  an OS-level firewall; it relies on tools having no other way to open sockets (the known ways are
  removed and covered by regression tests).
- DNS rebinding between check and connection is closed for the guarded `fetch()` (single, checked
  resolution per connection). It is not a defense against a compromised Node.js runtime.

## File system rules

Declared paths are passed to Node's permission model, so reads/writes elsewhere fail with
`PERMISSION_DENIED`. Node's permission model follows symbolic links, so packages that accept
paths from callers must check real paths themselves; `@splice/files` does (see its SKILL.md), and
also refuses credential-like names (`.env`, private keys, `.ssh`, `.aws`, `.npmrc`, …) inside its
sandbox.

Recommendation for skill authors: declare a dedicated directory (`workspace`, `out`, `data`),
never `.`.

## Why there is no process execution skill

`@splice/process` (`process.exec`) was considered and deliberately **not built**:

- The runtime runs tools with Node's permission model, which denies `child_process` entirely.
  Allowing it (`--allow-child-process`) would let a tool start a new, unrestricted process: the
  child is not bound by the parent's file, network or environment restrictions.
- Any command allowlist would be an in-process check around a primitive that can read every
  file, reach every network address and use every credential of the user — i.e. the sandbox would
  no longer mean anything for that package, and argument-level injection (`git -c core.pager=…`,
  `find -exec`, …) makes allowlists fragile.
- Real isolation for subprocesses needs OS-level sandboxing (containers, seccomp, VMs), which is
  outside the current architecture.

So arbitrary process execution is intentionally excluded from the official skill set. The tests
assert that no official package exposes such a tool and that the sandbox refuses child processes.

## Reviewing permissions

```sh
splice info @splice/http          # "network: any public host (private, loopback and link-local addresses are blocked)"
splice add @splice/http           # refused without consent
splice add @splice/http --accept-permissions
```

MCP clients get the same data in each tool's `_meta["io.spliceloom/permissions"]` and in the
`readOnlyHint` / `destructiveHint` / `openWorldHint` annotations.
