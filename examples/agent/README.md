# Example: agent using the Splice SDK

`agent.ts` is a small, real agent loop: task → install capability → discover tools → choose →
execute in the sandbox → structured JSON result. The "planner" is rule-based on purpose; replace
`plan()` with an LLM call and keep the SDK calls unchanged.

```sh
npm install && npm run build           # from the repository root
node examples/agent/agent.ts "count the words in: Splice composes capabilities"
node examples/agent/agent.ts "greet Dim"
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPLICE_REGISTRY` | CLI resolution (splice.json → ~/.splice/config.json → default) | Registry URL or alias (`local`) |
| `SPLICE_AGENT_DIR` | a new temporary directory | Project directory the agent installs into |

Output (abridged):

```json
{
  "ok": true,
  "task": "count the words in: Splice composes capabilities",
  "package": "@splice/example@0.1.1",
  "integrity": "sha256-…",
  "discovered": ["example.hello", "example.stats"],
  "tool": "@splice/example.stats",
  "input": { "text": "Splice composes capabilities" },
  "output": { "characters": 28, "words": 3, "lines": 1, "longestWord": "capabilities" }
}
```

Node.js ≥ 22.18 runs the TypeScript file directly (type stripping).
