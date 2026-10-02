# Packages

A Splice package (a *skill*) is a directory published as a deterministic `.tar.gz`. The format is
defined in [spec.md](spec.md); this page summarizes it and shows how the official packages use it.

## Contents

| Path | Required | Purpose |
| --- | --- | --- |
| `manifest.json` | yes | identity, version, runtime requirements, permissions, tools and their schemas |
| `SKILL.md` | yes | documentation for humans and agents (served as an MCP resource) |
| `tools/*.ts` / `*.js` | yes | tool entry points (default export `(input, ctx) => output`) |
| other files | no | shared code (`lib/`), `examples/`, `tests/`, data |

Hidden files (`.env`, `.git`, …) and `node_modules` are never packed. Tools cannot use npm
dependencies; they may import other files of the same package and Node built-ins.

## manifest.json

```json
{
  "specVersion": 1,
  "namespace": "splice",
  "name": "json",
  "version": "0.1.0",
  "description": "…",
  "license": "MIT",
  "runtime": { "type": "node", "minNodeVersion": "22.18.0" },
  "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] },
  "tools": [
    {
      "name": "parse",
      "description": "…",
      "entry": "tools/parse.ts",
      "input":  { "type": "object", "properties": { "text": { "type": "string", "maxLength": 1000000 } }, "required": ["text"], "additionalProperties": false },
      "output": { "type": "object", "properties": { "value": {}, "type": { "type": "string" } }, "required": ["value", "type"] },
      "timeoutMs": 5000
    }
  ]
}
```

Schemas use a strict subset of JSON Schema (`type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `min/maxLength`, `minimum/maximum`, `min/maxItems`,
`description`, `default`); unknown keywords are rejected. A property without `type` accepts any
JSON value. The runtime validates input before running a tool and output after.

## Tool contract

```ts
export default async function (input: Input, ctx: {
  package: { id: string; version: string };
  tool: string;
  paths: { project: string; package: string };
  permissions: Permissions;
  log: (...args: unknown[]) => void;
}): Promise<Output>
```

- Return plain JSON data. Throw an `Error` for failures; official skills start messages with a
  code (`INVALID_URL: …`), which callers receive as `TOOL_ERROR` with that message.
- Each call runs in a fresh sandboxed process with the declared permissions
  ([permissions.md](permissions.md)); `console.*` goes to logs, never to the output.

## Official package conventions

The official skills ([skills.md](skills.md)) add conventions on top of the format — useful for
any package:

- `runtime.minNodeVersion` declared; strict inputs (`additionalProperties: false`) with limits
  (`maxLength`, `maximum`, `maxItems`); an `output` schema for every tool.
- Explicit timeouts and size limits for anything that reads external data.
- `examples/*.json` with `{ tool, input, output? }`, validated against the schemas in tests.
- `tests/*.test.ts` that run with `node --test` and no Splice dependency.
- SKILL.md sections: when to use it, tools, errors, limits, permissions/security boundaries.

## Publishing

```sh
splice publish ./skills/json --dry-run     # validate + pack locally
splice publish ./skills/json               # needs `splice login` and rights to the namespace
```

The registry validates the manifest and SKILL.md again, stores the artifact (GitHub Releases),
records provenance, and refuses to change a published version ([publishing.md](publishing.md)).
