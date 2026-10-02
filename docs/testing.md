# Testing

How to test skills you write, and how the Splice repository tests itself.

## Testing a skill

Tools are plain modules with a default export, so most tests call them directly with Node's test
runner:

```sh
node --test tests/*.test.ts
```

- **Network tools:** replace `globalThis.fetch` in the test with a stub and assert on the requests
  your tool makes (see `skills/github/tests` in the repository).
- **Capability tools:** pass a stub context — `{ capability: async (name, args) => result }` — and
  assert on the capability name and arguments. The host behaviour is tested by Splice itself.
- **Schemas:** `splice publish --dry-run` validates the manifest and every schema; add examples
  (`examples/*.json` with `tool`, `input` and, where deterministic, `output`) for documentation.

Run the tool in the real sandbox before publishing by installing it into a project from a local
registry (`npm run registry:dev` in a source checkout, then `splice publish --registry local`).
Permission denials then behave exactly as in production.

## How the repository is tested

| Command | What runs |
| --- | --- |
| `npm test` | Build, then every unit and integration test: spec, runtime sandbox, core, registry (SQLite and the real Worker in workerd), SDK, MCP (including the official MCP SDK client), CLI, official skills in the sandbox, data layer, website build. No network. |
| `npm run test:live` | Real provider requests with the keys in `.env.local`: Robinhood Chain RPC and indexers, market data, security, wallets, GitHub, AI, web search, and the capability broker. Inputs are discovered live; nothing is hardcoded. |
| `npm run typecheck` | TypeScript for packages, skills, examples and the website. |
| `npm run secret-scan` | Configured credential values and known key formats in the repository, build output and the staged npm package. |

Unit tests may stub provider HTTP only inside test files (the `fetch` test seam of the data
layer); production code has no mock or fixture path. Live tests fail if any result contains a
configured key.
