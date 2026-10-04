# @splice/stock-token-desk

An agent for Robinhood stock tokens.

It is an agent package: it ships instructions, not code. It may call the tools of
`@splice/robinhood` and nothing else. Each call runs in that skill's sandbox with that skill's
permissions; the agent has no permissions of its own and holds no keys.

## Run

```sh
splice add @splice/robinhood --accept-permissions
splice add @splice/stock-token-desk
splice agent run @splice/stock-token-desk "Is the NVDA token trading at a premium right now?"
```

## What it does

- Reads a stock token from every source side by side and states the gap between the DEX price,
  Robinhood's quote and the oracle price.
- Adds the perp market and funding for the same ticker when asked.
- Says when the US market is closed and a quote is stale or wide.
- Does not recommend buying or selling and does not predict prices. A stock token is not the stock.
