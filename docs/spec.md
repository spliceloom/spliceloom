# Package specification — version 1

A Splice package (skill) is a directory:

```
my-skill/
├── manifest.json     required — identity, permissions, tools
├── SKILL.md          required — human/agent documentation
├── tools/            tool modules referenced by the manifest
│   └── hello.ts
└── examples/         optional — sample inputs/outputs (JSON)
```

Hidden files (`.env`, `.git`, …) and `node_modules/` are never packed, and the registry and
installer reject archives that contain them. Symbolic links are rejected. `SKILL.md` must be
non-empty UTF-8 text without NUL bytes (≤ 256 KiB); each file ≤ 2 MiB.

## manifest.json

```json
{
  "specVersion": 1,
  "namespace": "splice",
  "name": "example",
  "version": "0.1.0",
  "description": "Official example skill.",
  "license": "MIT",
  "homepage": "https://spliceloom.com",
  "runtime": { "type": "node" },
  "permissions": {
    "fs": { "read": [], "write": [] },
    "network": [],
    "env": []
  },
  "tools": [
    {
      "name": "hello",
      "description": "Return a greeting for the given name.",
      "entry": "tools/hello.ts",
      "input": {
        "type": "object",
        "properties": { "name": { "type": "string", "minLength": 1 } },
        "required": ["name"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
      },
      "timeoutMs": 5000
    }
  ]
}
```

### Fields

| Field | Required | Rules |
| --- | --- | --- |
| `specVersion` | yes | Must be `1`. Unknown versions are rejected so the format can evolve safely. |
| `namespace` | yes | `^[a-z0-9][a-z0-9-]{0,63}$`. The package id is `@namespace/name`. |
| `name` | yes | Same pattern as `namespace`. No dots (dots separate package and tool). |
| `version` | yes | Semantic version (`1.2.3`, `1.0.0-beta.1`). Published versions are immutable. |
| `description` | yes | ≤ 500 characters. |
| `license`, `homepage` | no | Strings ≤ 500 characters. |
| `runtime` | no | `{ "type": "node", "minNodeVersion"?: "22.18.0" }`. `type` is the only runtime in v1 (default). `minNodeVersion` (optional, added in Phase 4, backward compatible) makes the runtime refuse to run the tools on older Node.js with `RUNTIME_UNSUPPORTED`. |
| `permissions` | no | See below. Omitted = no permissions. |
| `tools` | yes | Non-empty array of tool definitions with unique names. |
| `dependencies` | no | **Reserved.** `{ "@ns/name": "<range>" }`, validated (package ids, ranges except `latest`, no self-dependency) but not supported yet: the registry rejects packages that declare dependencies. See [trust.md](trust.md#dependencies). |
| `x-*` | no | Extension fields are allowed and ignored. Any other unknown field is an error. |

### Tool definition

| Field | Required | Rules |
| --- | --- | --- |
| `name` | yes | `^[a-z][a-z0-9-]{0,63}$`. Invoked as `<package>.<name>`. |
| `description` | yes | ≤ 500 characters. |
| `entry` | yes | Package-relative path, forward slashes, no `..`, ending in `.ts`, `.mts`, `.js` or `.mjs`. |
| `input` | yes | Schema with `"type": "object"` (use `{"type":"object"}` for no input). |
| `output` | no | Schema; when present the runtime validates the tool's return value. |
| `timeoutMs` | no | 1–60000. Default 10000. |

### Schema subset

Tool schemas use a small subset of JSON Schema. Unsupported keywords are **rejected** (never
silently ignored): `type` (`object`, `string`, `number`, `integer`, `boolean`, `array`, `null`),
`description`, `properties`, `required`, `additionalProperties` (boolean), `items`, `enum`,
`minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `default`
(documentation only — not applied).

### Permissions

Everything is denied unless declared.

| Key | Meaning | Enforcement (Phase 1) |
| --- | --- | --- |
| `fs.read` | Project-relative paths the tool may read (`"."` = whole project). | Node.js permission model (`--allow-fs-read`). |
| `fs.write` | Project-relative paths the tool may write (also readable). Created if missing. | Node.js permission model (`--allow-fs-write`). |
| `network` | Hostnames for `fetch()` (`api.github.com`, `*.example.com`), or `"*"` for any public host (Phase 7). Non-public addresses (loopback, private, link-local/metadata, …) are refused unless that exact IP literal or `localhost` is declared. | In-process guard, re-checked on every redirect hop (best effort — see [permissions.md](permissions.md#network-rules)). |
| `env` | Environment variable names passed to the tool. | Only declared variables exist in the tool process. |
| `capabilities` | Host capabilities callable with `context.capability(name, args)` (names in `BROKER_CAPABILITIES`, e.g. `web.search`). Omitted when empty. | Checked by the host for every call; run by the host broker ([capabilities.md](capabilities.md)). |

The package's own directory is always readable. Paths must not be absolute or contain `..`.
Child processes, worker threads, native addons, WASI and `eval` are always denied.

## Tool descriptors

`describeTools(manifest)` (in `@spliceloom/spec`) turns the manifest into the stable contract the
SDK, the MCP servers and the registry `/mcp` endpoint expose: `name` (`example.hello`),
`qualifiedName` (`@splice/example.hello`), `mcpName` (`splice_example_hello`), `description`,
`inputSchema`, `outputSchema`, `permissions`, `annotations`, `timeoutMs`. No field is invented —
everything comes from the manifest.

## Tool module contract

```ts
export default async function (input, context) {
  return { /* JSON-serializable output */ };
}
```

- `input`: the validated input object.
- `context`: `{ package: { id, version }, tool, paths: { project, package }, permissions, log(...), capability(name, args) }`.
  `capability` resolves to the host result (LIVE / CACHED / UNAVAILABLE / ERROR) and rejects with
  `ERR_ACCESS_DENIED` for capabilities the package did not declare.
- Return any JSON-serializable value (non-JSON values are dropped by serialization).
- Throwing reports `TOOL_ERROR` with the error message.
- `console.*` and `context.log` go to the tool logs, never to the output.
- TypeScript must use erasable syntax only (no `enum`, `namespace`, parameter properties):
  Node strips types at load time; there is no build step.
- Tools may import relative files inside the package and Node built-ins allowed by their
  permissions. Third-party npm dependencies are not supported in v1 — vendor small helpers.

## Package archive (`.tar.gz`)

Since Phase 3.5 every published version is one deterministic `.tar.gz`:

- ustar entries for the package files only (no directories), sorted by path;
- every header: mode `0644`, uid/gid `0`, mtime `0`, empty user/group names;
- gzip layer with a fixed header (mtime `0`, OS `255`) and *stored* (uncompressed) deflate blocks.

The result is byte-for-byte reproducible on any OS and runtime (Node.js, Workers), so the SHA-256
computed by the CLI, the registry and GitHub always agree. Any `tar`/`gzip` tool can extract it.
Integrity: `sha256-<hex of SHA-256 over the .tar.gz bytes>`. Limits: 5 MB archive, 500 files,
16 MB decompressed.

Reading is strict: only regular files; symlinks, hard links, devices and PAX/GNU extension headers
are rejected; paths must pass the same safety rules as below (no `..`, no absolute paths, no
backslashes, no case-insensitive duplicates); header checksums are verified. Implemented in
`@spliceloom/spec` (`encodeTarGz`, `decodePackageArchive`).

## Legacy JSON bundle

Phase 1/2 artifacts used a JSON bundle; clients and the registry still read it
(`decodePackageArchive` detects the format):

```json
{ "format": "splice-bundle", "formatVersion": 1,
  "files": [ { "path": "SKILL.md", "content": "<base64>" }, … ] }
```

- Files are sorted by path, making the bytes deterministic for identical contents.
- Integrity: `sha256-<hex of SHA-256 over the bundle bytes>`.
- Limits: 5 MB, 500 files. Unsafe paths (`..`, absolute, backslashes) and case-insensitive
  duplicates are rejected when decoding.

## Evolving the spec

Breaking changes increment `specVersion`; the runtime and registry list the versions they
support and reject others with a clear error. Additive, optional fields may be added within a
version. Vendors can experiment with `x-*` fields.
