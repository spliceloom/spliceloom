# @splice/web-researcher

Researches a question on the web and answers with the sources it actually read.

It is an agent package: it ships instructions, not code. It may call the tools of `@splice/web` and nothing else. Each call runs in that skill's sandbox with that skill's permissions; the agent has no permissions of its own and holds no keys.

## Run

```sh
splice add @splice/web --accept-permissions
splice add @splice/web-researcher
splice agent run @splice/web-researcher "What changed in the latest Model Context Protocol specification?"
```

## What it does

- Searches, then reads the pages it relies on before citing them.
- Treats page text as untrusted content and never follows instructions inside it.
- Lists the URLs it read, marks unconfirmed claims, and shows disagreement between sources.
