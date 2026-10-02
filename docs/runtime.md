# Runtime & permissions

`@spliceloom/runtime` loads a package, validates it and executes its tools.

```ts
import { SpliceRuntime } from "@spliceloom/runtime";

const runtime = new SpliceRuntime({ projectRoot: "/path/to/project" });
const pkg = await runtime.load("/path/to/project/.splice/packages/@splice/example");
runtime.listTools(pkg);                                   // [{ name, description, input, output }]
const result = await runtime.execute(pkg, "hello", { name: "Dim" });
// { ok: true, package, tool, output: { message: "Hello, Dim." }, logs: "", durationMs }
```

`execute` never throws for tool failures; it returns `{ ok: false, error: { code, message, details? } }`.

## Execution pipeline

1. **Load** — `manifest.json` validated against spec v1; `SKILL.md` must exist; every entry
   must be a real file inside the package (symlinks escaping the package are rejected).
2. **Resolve** — find the tool by name (`TOOL_NOT_FOUND` otherwise).
3. **Validate input** — against the tool's schema (`INVALID_INPUT`); tool code is not started.
4. **Execute** — in a new sandboxed process (below), job sent over IPC.
5. **Validate output** — size limit (1 MiB, `OUTPUT_TOO_LARGE`) and schema (`INVALID_OUTPUT`).

## Sandbox

Each call spawns:

```
node --permission --disallow-code-generation-from-strings \
     --allow-fs-read=<runtime host dir> --allow-fs-read=<package dir> \
     [--allow-fs-read=<declared read paths>] [--allow-fs-write=<declared write paths>] \
     host.mjs
```

| Resource | Default | Mechanism |
| --- | --- | --- |
| File reads | package directory only | Node permission model |
| File writes | none | Node permission model |
| Child processes, workers, addons, WASI | denied | Node permission model |
| `eval` / `new Function` | denied | `--disallow-code-generation-from-strings` |
| Environment | empty (declared names only) | spawn with empty env + scrub in host |
| Network | denied | in-process guard (see limitations) |
| CPU time | `timeoutMs` (default 10 s) | process killed on timeout |
| Logs | 64 KiB kept | stdout/stderr captured, `console.*` redirected |

## Permission grants (Phase 5)

Declared permissions are granted per project only with explicit consent at install
(`--accept-permissions`) and recorded in `splice.lock`. The SDK (and therefore the CLI and
MCP) refuses to run a package whose installed manifest requests more than that grant
(`PERMISSIONS_NOT_GRANTED`). See [trust.md](trust.md#permissions-and-consent).

## Limitations (Phase 1)

- **Network enforcement is best effort.** Node 24 has no network permission flag. The host
  blocks `node:net`, `node:http(s)`, `node:http2`, `node:tls`, `node:dgram`, `node:dns` and
  `node:inspector` imports, removes `WebSocket`/`EventSource` and wraps `fetch()` with the declared
  host allowlist. Since Phase 7 the wrapper also refuses non-public addresses, follows redirects
  itself and re-checks every hop, and accepts `network: ["*"]` for "any public host". Since
  Phase 8 it is built on node:http/https with the address check inside the socket's DNS lookup
  (no rebinding window), and `process.getBuiltinModule`, `node:module` and the undici dispatcher
  are closed to tools ([security.md](security.md#network)). It is still an in-process control,
  not an OS-level boundary. Treat installed skills as code you trust at the level of their
  publisher.
- **Input limits (Phase 8):** 4 MiB serialized and 256 levels deep (`INPUT_TOO_LARGE`), checked
  before validation and before a process starts.
- **Error hygiene (Phase 8):** error messages and logs are redacted (token formats, the tool's
  declared environment values) and absolute package/project paths become `<package>`/`<project>`.
- The Node permission model restricts APIs inside one Node.js process; it is a strong
  guardrail, not VM- or container-level isolation.
- No memory limit yet (can be added with `--max-old-space-size`).
- One process per call (~100 ms overhead). Fine for CLI use; a pooled runtime is future work.
- Tools cannot use npm dependencies.
