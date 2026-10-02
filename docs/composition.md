# Composition

Splice skills are small tools with structured input and output. Composition is simply passing
one tool's output into another tool's input. Splice provides no workflow engine, DSL or
orchestration framework, and needs none: the agent (or your code) decides the order.

## Skill A output → Skill B input

```ts
import { Splice } from "@spliceloom/sdk";

const splice = new Splice({ project: "./agent" });
await splice.init();
await splice.add("@splice/json");
await splice.add("@splice/http", { acceptPermissions: true });

// A: fetch raw text
const page = await splice.run("http.get", { url: "https://api.github.com/repos/spliceloom/splice-artifacts", responseType: "text" });
if (!page.ok) throw new Error(page.error.message);

// B: text → structured value
const parsed = await splice.run("json.parse", { text: page.output.text });
if (!parsed.ok) throw new Error(parsed.error.message);

// B: keep only what is needed
const picked = await splice.run("json.pick", { value: parsed.output.value, paths: ["full_name", "stargazers_count", "license.spdx_id"] });
```

Every step runs in its own sandbox process with only its own package's permissions: the JSON
step cannot use the network even though the previous step could.

## Runnable example

[`examples/agent-composition/compose.ts`](../examples/agent-composition/compose.ts) — deterministic by default
(`@splice/files` → `@splice/json`), or `--url` for `@splice/http` → `@splice/json`. It prints each
step and the final structured result; it needs no LLM or API key and is executed by the test
suite against a local registry.

```sh
SPLICE_REGISTRY=https://registry.spliceloom.com node examples/agent-composition/compose.ts
```

## Choosing tools from descriptors

A model-driven agent uses the descriptors, not hard-coded names:

```ts
const tools = await splice.tools();   // name, description, inputSchema, outputSchema, permissions
// give `tools` to the model; execute what it picks with splice.run(tool.qualifiedName, input)
```

`outputSchema` tells the model what the next step will receive, which is what makes chaining
reliable. Over MCP the same happens automatically: an MCP client sees every installed tool with
both schemas and calls them in sequence.

## Guidelines

- Keep intermediate data small: `json.pick` instead of passing whole documents around.
- Prefer returning structured data from your own skills (declare `output`), so they compose.
- Permissions do not add up across steps; each tool keeps its own. Grant the minimum per package.
- Handle `{ ok: false }` at every step; errors are data, not exceptions.
