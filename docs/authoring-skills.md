# Authoring skills

A **skill** is a Splice package: a directory with a manifest, documentation and tool modules,
published to a registry as an immutable, SHA-256-addressed artifact. This guide builds one from
scratch, tests it and publishes it. The format is specified in [spec.md](spec.md); the official
skills in `skills/` follow everything below.

## 1. Layout

```
slugify/
├── manifest.json        required: identity, runtime, permissions, tools + schemas
├── SKILL.md             required: documentation for humans and agents
├── tools/
│   └── slugify.ts       one module per tool (default export)
├── lib/                 optional: code shared by tools
├── examples/
│   └── slugify.json     recommended: { tool, input, output? }
└── tests/
    └── slugify.test.ts  recommended: node --test, no Splice dependency
```

Everything except hidden files (`.env`, `.git`, …) and `node_modules` is packed — `examples/` and
`tests/` are published too, so users can inspect them. Symlinks are rejected. Limits: 5 MB,
500 files, 2 MiB per file.

## 2. manifest.json

```json
{
  "specVersion": 1,
  "namespace": "acme",
  "name": "slugify",
  "version": "0.1.0",
  "description": "Turn text into URL-friendly slugs.",
  "license": "MIT",
  "runtime": { "type": "node", "minNodeVersion": "22.18.0" },
  "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] },
  "tools": [
    {
      "name": "slugify",
      "description": "Convert text into a lowercase, dash-separated slug.",
      "entry": "tools/slugify.ts",
      "input": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "minLength": 1, "maxLength": 1000 },
          "separator": { "type": "string", "enum": ["-", "_"], "default": "-" }
        },
        "required": ["text"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": { "slug": { "type": "string" } },
        "required": ["slug"],
        "additionalProperties": false
      },
      "timeoutMs": 5000
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `namespace`, `name` | lowercase letters, digits, `-`; the package id is `@namespace/name` |
| `version` | semver (`1.2.3`, `1.2.3-beta.1`; build metadata `+x` is rejected) |
| `runtime` | `{ "type": "node" }`, optional `minNodeVersion` |
| `tools[].name` | `^[a-z][a-z0-9-]{0,63}$` — referenced as `slugify.slugify`, MCP name `acme_slugify_slugify` |
| `tools[].input` | JSON-schema subset, must describe an object |
| `tools[].output` | optional but recommended: the runtime validates results against it |
| `tools[].timeoutMs` | 1–60000, default 10000 |
| `dependencies` | reserved: rejected by the registry |

**Schema subset:** `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
`minLength`/`maxLength`, `minimum`/`maximum`, `minItems`/`maxItems`, `description`, `default`.
Unknown keywords are rejected, so no constraint is silently ignored. A property without `type`
accepts any JSON value. Use `additionalProperties: false` and limits (`maxLength`, `maximum`,
`maxItems`) on every input.

## 3. Tools

A tool module default-exports a function that receives the validated input and a context and
returns JSON data:

```ts
interface Input {
  text: string;
  separator?: "-" | "_";
}

export default function slugify(input: Input): { slug: string } {
  const sep = input.separator ?? "-";
  const slug = input.text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "");
  return { slug };
}
```

- TypeScript is supported without a build step (erasable syntax only: no enums, namespaces or
  parameter properties). Plain `.js`/`.mjs` works too.
- Tools can import Node built-ins and files of the same package (`../lib/x.ts`), **not** npm
  packages.
- The second argument is `{ package, tool, paths: { project, package }, permissions, log }`.
- Throw an `Error` for failures. The official skills start messages with a code
  (`INVALID_URL: …`); callers receive `TOOL_ERROR` with that message.
- `console.*` output goes to the result's `logs`, never into the output.
- Return plain JSON (objects, arrays, strings, numbers, booleans, null); output is limited to 1 MiB.

## 4. Permissions

Declare only what the tools need. Everything else is refused by the runtime, whatever the code
tries ([permissions.md](permissions.md)):

```json
"permissions": {
  "fs": { "read": ["data"], "write": ["out"] },
  "network": ["api.github.com"],
  "env": ["SERVICE_API_KEY"]
}
```

| Kind | Values | Enforced by |
| --- | --- | --- |
| `fs.read` / `fs.write` | project-relative paths, no `..` (`.` = whole project — avoid) | Node.js permission model |
| `network` | host names, `*.example.com`, or `*` (any public host) | runtime network guard |
| `env` | variable names | empty environment + declared names |

Packages that declare permissions need `--accept-permissions` at install, and the grant is
recorded in `splice.lock`. A later version that asks for more needs consent again.

Paths passed by callers must be checked by your code: Node's permission model follows symlinks.
Copy the approach of `@splice/files` (`skills/files/lib/sandbox.ts`) if your skill accepts paths.

## 5. SKILL.md

`SKILL.md` is part of the published package (readers find it in the installed package directory)
and is served to agents as an MCP resource (`splice://packages/@ns/name/SKILL.md`).
Include: what the skill does and when an agent should use it, every tool with its inputs, output
and error codes, the permissions and why they are needed, limits, and examples. See the official
skills, e.g. [skills/json/SKILL.md](../skills/json/SKILL.md).

## 6. Examples and tests

`examples/<tool>.json`:

```json
{ "tool": "slugify", "input": { "text": "Hello Splice World" }, "output": { "slug": "hello-splice-world" } }
```

`tests/slugify.test.ts` — plain `node:test`, importing the tool directly:

```ts
import assert from "node:assert/strict";
import { it } from "node:test";
import slugify from "../tools/slugify.ts";

it("slugifies", () => {
  assert.deepEqual(slugify({ text: "Hello Splice World" }), { slug: "hello-splice-world" });
});
```

```sh
node --test tests/*.test.ts
```

To test inside the real sandbox (permissions, schemas, timeouts), install the skill into a
throw-away project from a local registry ([local-development.md](local-development.md)) or use
`SpliceRuntime` from `@spliceloom/runtime`, as the repository's integration tests do.

## 7. Validate and publish

```sh
splice publish ./slugify --dry-run      # validate + pack locally: no network, no login
splice login                            # a registry token (created by a registry admin)
splice publish ./slugify
```

The registry validates again, stores the artifact (GitHub Releases), records provenance and
**never** accepts a second artifact for the same version — bump `version` for every change. The
first publish to an unowned namespace claims it for you; `@splice` is reserved. Details:
[publishing.md](publishing.md).

## 8. Verify and use

```sh
splice verify @acme/slugify@0.1.0
splice add @acme/slugify
splice run slugify.slugify text="Hello Splice World"
```

## 9. Versioning

- Follow semver: breaking input/output or permission changes → major (`1.x → 2.0.0`; `0.x`
  minors are breaking by convention); new optional inputs/tools → minor; fixes → patch.
- Users pin ranges in `splice.json` (`^0.1.0`) and receive in-range versions with
  `splice update`; exact bytes are pinned in `splice.lock`.
- A published version can never be replaced or deleted. Publish a fix as a new version.

## Checklist

- [ ] `manifest.json` validates (`splice publish --dry-run`), `runtime.minNodeVersion` set.
- [ ] Every tool: strict `input` (`additionalProperties: false`, limits) and an `output` schema.
- [ ] Minimal permissions; `SKILL.md` explains each one.
- [ ] Tools use only Node built-ins and package files; errors are clear and contain no secrets.
- [ ] `examples/` cover every tool; `tests/` pass with `node --test`.
- [ ] No secrets in the directory (hidden files are never packed, but don't rely on that).
- [ ] Version bumped.
