# @splice/token-analyst

An agent that researches a token on Robinhood Chain.

It is an agent package: it ships instructions, not code. It may call the tools of
`@splice/robinhood` and nothing else. Each call runs in that skill's sandbox with that skill's
permissions; the agent has no permissions of its own and holds no keys.

## Run

```sh
splice add @splice/robinhood --accept-permissions
splice add @splice/token-analyst
splice agent run @splice/token-analyst "Research PONS on Robinhood Chain"
```

`splice agent info @splice/token-analyst` prints the instructions and the tools it can call.

## What it does

- Starts from the research report (market stats, security checks, holders), then live stats.
- Looks at large trades when the question is about who is buying or selling.
- States numbers as the tools returned them, with their source, and says which data is missing
  when a provider is unavailable.
- Does not recommend buying or selling and does not predict prices.

The model is the one configured on the host (`AI_ASK_MODEL`, else the default); pass `--model`
to choose another.
