# Onchain data

Blocks, transactions, balances, contracts, logs, tokens, wallets and security reports for
Robinhood Chain mainnet (chain ID 4663), with the block every answer refers to.

| Provider | Key | Role |
| --- | --- | --- |
| Alchemy | `ALCHEMY_RPC_URL` or `ALCHEMY_API_KEY` | primary RPC; token balances, metadata and transfers |
| QuickNode | `QUICKNODE_RPC_URL` | RPC fallback; call traces |
| Goldsky Edge | `GOLDSKY_API_KEY` | additional RPC |
| Robinhood public RPC | none (on by default) | keyless RPC; `ROBINHOOD_PUBLIC_RPC_URL=off` disables it |
| Blockscout PRO | `BLOCKSCOUT_API_KEY` | indexed transactions, holders, transfers, verified contracts, counters |
| GoPlus | optional | token and address security |
| Zerion | `ZERION_API_KEY` | wallet portfolio and positions |

Every RPC provider's `eth_chainId` is verified before first use; a provider reporting another chain
is never used for Robinhood Chain.

## Use it

```sh
splice chain info
splice block latest
splice tx inspect 0x<hash>
splice wallet inspect 0x<address>
splice token inspect 0x<token>
splice contract inspect 0x<address>
splice logs query --address 0x<contract> --from-block 77165000 --to-block 77165100
splice security token 0x<token>
```

SDK: `splice.onchain.*`, `splice.wallet.*`, `splice.security.*`. MCP: `onchain_get_balance`,
`onchain_get_transaction`, `onchain_get_block`, `onchain_get_token`, `onchain_get_contract`,
`onchain_get_transfers`, `onchain_get_logs`, `security_get_token`, `wallet_get_portfolio`. Skills:
the `onchain.*` host capabilities, or `@splice/onchain`.

## What a result contains

`LIVE` results carry `provenance`: provider, chain, chain id, fetch time, block number (balances,
nonce and code are read at the head block the provider reported) and the fallback trail. Fields a
provider does not return are absent — never zero or "unknown". Composite answers (`wallet inspect`,
`token inspect`, `contract inspect`, `tx inspect`) have one section per source, each with its own
status.

## Not available

Approval security (GoPlus does not support it on Robinhood Chain) and the first activity of an
address (needs full history) are reported as `UNAVAILABLE`. Full details per provider:
[Providers reference](data-providers.md).
