# Skill composition example

`compose.ts` chains official skills with the SDK. Each tool's structured output is passed as
the next tool's input; there is no workflow engine or framework involved.

```
@splice/files  files.write / files.read   → content (string)
@splice/json   json.parse                 → value (structured)
@splice/json   json.pick                  → the few fields the agent needs
```

With `--url`, the first step is `@splice/http` `http.get` (raw text) instead of reading a file.

```sh
npm run build
SPLICE_REGISTRY=https://registry.spliceloom.com node examples/agent-composition/compose.ts
SPLICE_REGISTRY=https://registry.spliceloom.com node examples/agent-composition/compose.ts \
  --url https://api.github.com/repos/spliceloom/splice-artifacts
```

Output (default mode):

```json
{
  "ok": true,
  "source": "workspace/fixtures/repository.json",
  "result": {
    "full_name": "spliceloom/splice",
    "stargazers_count": 42,
    "license.spdx_id": "MIT",
    "topics[0]": "agents",
    "owner.login": "spliceloom"
  },
  "missing": [],
  "steps": ["files.write", "files.read", "json.parse", "json.pick"]
}
```

No LLM or API key is needed; in a real agent, a model would choose the tools and the paths from
the descriptors returned by `splice.tools()`. The example accepts the permissions of
`@splice/files` (workspace/ only) and `@splice/http` (public hosts only) programmatically — a
real agent should show them to a human first (`splice info @splice/http`).
