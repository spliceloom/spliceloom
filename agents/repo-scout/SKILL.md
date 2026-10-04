# @splice/repo-scout

Finds and compares public GitHub repositories from their metadata.

It is an agent package: it ships instructions, not code. It may call the tools of `@splice/github` and nothing else. Each call runs in that skill's sandbox with that skill's permissions; the agent has no permissions of its own and holds no keys.

## Run

```sh
splice add @splice/github --accept-permissions
splice add @splice/repo-scout
splice agent run @splice/repo-scout "Find maintained MCP servers written in TypeScript with a permissive license"
```

## What it does

- Builds a GitHub search from what you describe, or reads a named repository or owner.
- Reports stars, language, license and last push exactly as GitHub returns them.
- Says what it cannot check from metadata alone, such as code quality or security.
