# @splice/tx-explainer

Explains a transaction or an address on Robinhood Chain in plain English.

It is an agent package: it ships instructions, not code. It may call the tools of `@splice/onchain` and nothing else. Each call runs in that skill's sandbox with that skill's permissions; the agent has no permissions of its own and holds no keys.

## Run

```sh
splice add @splice/onchain --accept-permissions
splice add @splice/tx-explainer
splice agent run @splice/tx-explainer "Explain transaction 0x975ef0bdc726acd648eff995422f34a26d71a94fadf471770fb2ee201ca4a448"
```

## What it does

- Reads the transaction and its receipt, the native balance, or a token report.
- Says whether a transaction succeeded, reverted or is pending, and quotes hashes and amounts exactly.
- Says so when the data does not show what a transaction did, instead of guessing.
