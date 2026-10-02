# @splice/json

Deterministic JSON utilities for agents: turn JSON text into structured data, serialize data
back to (canonical) JSON, and extract specific values by path.

**Permissions: none.** No files, no network, no environment variables. Installs without
`--accept-permissions`.

## When should an agent use this skill?

- An API or file returned JSON *as text* and you need structured data → `json.parse`.
- You need stable JSON text (for hashing, diffing, caching keys) → `json.stringify` with `sortKeys`.
- You only need a few fields from a large document → `json.pick` (keeps your context small).

## Tools

### `json.parse`

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | max 1,000,000 characters |

Output: `{ "value": any, "type": "object" | "array" | "string" | "number" | "boolean" | "null" }`

Invalid JSON fails with `INVALID_JSON: at position 6 (line 1, column 7): …` or
`INVALID_JSON: unexpected end of input (…)`.

### `json.stringify`

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `value` | any | yes | |
| `indent` | integer 0–8 | no | default 0 (compact) |
| `sortKeys` | boolean | no | sort object keys recursively → canonical output |

Output: `{ "text": string, "bytes": integer }` (`bytes` = UTF-8 length).

### `json.pick`

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `value` | any | yes | the document |
| `paths` | string[] (1–100) | yes | e.g. `owner.login`, `items[0].name`, `["key.with.dots"]`, `$` |

Output: `{ "results": [{ "path", "found", "value"? }], "missing": [path, …] }` in the order of
`paths`. Missing paths are reported, not errors. Only own properties are read (no prototype
access); malformed paths fail with `INVALID_PATH`.

Path syntax: dot segments (any characters except `.`, `[`, `]`), `[index]`, `["quoted key"]`
(JSON string syntax); `$` or a leading `$.` refers to the whole value.

## Examples

```sh
splice run json.parse text='{"a":[1,2]}'
splice run json.stringify --input '{"value":{"b":1,"a":2},"sortKeys":true}'
splice run json.pick --input '{"value":{"owner":{"login":"spliceloom"}},"paths":["owner.login"]}'
```

More in `examples/` (each file: `tool`, `input`, expected `output`).

## Limits

Input text up to 1,000,000 characters and at most 256 levels of nesting (`INVALID_JSON: nested
deeper than 256 levels`, checked before parsing); tool output up to the Splice runtime limit
(1 MiB); 5 s timeout per call. The Splice runtime limits tool input to 4 MiB and 256 levels.

Changes in 0.1.1: the nesting limit.
