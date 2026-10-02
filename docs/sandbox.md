# Sandbox

Every tool call runs in a separate, restricted Node.js process. This page summarises what that
process can and cannot do; [Runtime](runtime.md) has the implementation details and
[security model](security.md) the full threat model.

## The tool process

| Area | Enforcement |
| --- | --- |
| Files | Node.js permission model (`--permission`): read access to the package and declared `fs.read` paths, write access only to declared `fs.write` paths. Paths are project-relative; `..`, absolute paths, UNC paths and links out of the sandbox are refused. Hard links are refused. |
| Processes | No child processes, worker threads, native addons, WASI or the inspector. |
| Code | `eval` and `new Function` are disabled (`--disallow-code-generation-from-strings`). |
| Environment | Starts empty; only declared variable names are passed. |
| Network | Only `fetch()` to declared hosts, through the network guard ([Network security](network-security.md)). Raw sockets, `http`, `https`, `net`, `tls`, `dns`, `dgram` and the `module` hooks are blocked. |
| Host capabilities | Only declared ones, through the broker; the host checks every call ([Host capabilities](capabilities.md)). |
| Resources | Input up to 4 MiB and 256 levels deep, output up to 1 MiB, logs up to 64 KiB, a per-tool timeout (default 10 s, maximum 60 s), 25 capability calls per execution. |

## Before code runs

Nothing from a package executes during install. `splice add` verifies the artifact (SHA-256, size,
safe archive decoding, manifest) and records the grant; the code first runs when a tool is called,
and only after the installed files are checked against the digest in `splice.lock`.

## Limitations

The sandbox is built on the Node.js permission model plus an in-process network guard. It is a
strong guardrail, **not OS-level isolation** (no VM, container or seccomp profile). Run untrusted
packages on machines where that difference matters only after reviewing them.
