# Your first skill

A skill is a folder with a `manifest.json`, a `SKILL.md` and one module per tool. This page builds
a small one end to end; [Skill authoring](authoring-skills.md) is the complete reference.

## 1. Layout

```
greeter/
  manifest.json
  SKILL.md
  tools/greet.ts
  tests/greet.test.ts
```

## 2. Manifest

```json
{
  "specVersion": 1,
  "namespace": "yourname",
  "name": "greeter",
  "version": "0.1.0",
  "description": "Friendly greetings for agents",
  "license": "MIT",
  "runtime": { "type": "node", "minNodeVersion": "22.18.0" },
  "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] },
  "tools": [
    {
      "name": "greet",
      "description": "Greet someone by name",
      "entry": "tools/greet.ts",
      "input": {
        "type": "object",
        "properties": { "name": { "type": "string", "minLength": 1, "maxLength": 100 } },
        "required": ["name"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
      }
    }
  ]
}
```

The empty permissions mean the tool gets no files, no network, no environment and no host
capabilities. The runtime validates input against `input` before the tool starts, and output
against `output` after it returns.

## 3. Tool

```ts
// tools/greet.ts — default export: (input, context) => JSON-serializable output
export default async function greet(input: { name: string }) {
  return { text: `Hello, ${input.name}!` };
}
```

TypeScript is stripped at load time; use erasable syntax only (no `enum` or `namespace`).

## 4. Test

```ts
// tests/greet.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import greet from "../tools/greet.ts";

test("greets", async () => {
  assert.deepEqual(await greet({ name: "Ada" }), { text: "Hello, Ada!" });
});
```

```sh
node --test tests/*.test.ts
```

## 5. Validate and publish

```sh
splice publish ./greeter --dry-run
```

The dry run validates the manifest, schemas, file paths and archive exactly like the registry will.
Publishing needs a registry token ([Publishing](publishing.md)); published versions are
immutable.

## Using data without keys

To read chain data, prices or web results, declare host capabilities instead of network access —
the host runs them with its own provider keys ([Host capabilities](capabilities.md)):

```json
"permissions": { "network": [], "env": [], "capabilities": ["market.price"] }
```

```ts
export default async function price(input: { token: string }, ctx) {
  return ctx.capability("market.price", { token: input.token });
}
```
