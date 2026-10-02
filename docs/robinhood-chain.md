# Robinhood Chain

Robinhood Chain is a public blockchain network. Splice is not part of it and is not affiliated with
Robinhood: Splice reads Robinhood Chain data through its providers and exposes it to agents as
permissioned, verifiable capabilities. This page keeps the two apart.

## The network (Robinhood infrastructure)

From Robinhood's public documentation and product pages
([docs.robinhood.com/chain](https://docs.robinhood.com/chain/connecting/),
[robinhood.com/chain](https://robinhood.com/us/en/chain/)):

| Property | Detail |
| --- | --- |
| What it is | A permissionless Layer 2 blockchain built for financial services and tokenized real-world assets |
| Technology | Built on Arbitrum's Layer 2 infrastructure; block times around 100 ms |
| Compatibility | Fully EVM-compatible: anyone can interact with the network, build applications and deploy smart contracts |
| Assets | Designed for tokenized real-world assets such as Stock Tokens that can be held, transferred and composed into applications |
| Chain ID | `4663` (mainnet) |
| Gas | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (standard JSON-RPC and WebSocket) |
| Explorer | `https://robinhoodchain.blockscout.com` |

Splice independently observes some of these facts with every request: RPC providers must answer
`eth_chainId = 4663`, and the Blockscout statistics report an average block time of roughly 100 ms.

## Why Splice supports it

- **Standard surfaces.** EVM JSON-RPC, a Blockscout index and DEX market coverage mean agents can
  read state with the same methods Splice uses everywhere.
- **Financial data onchain.** A network built for financial services and tokenized assets is a
  natural source of real-world data for agents that analyse or act on markets.
- **Permissionless access.** No allow-list between an agent and the chain.

Splice supports **mainnet only** (chain ID 4663).

## How Splice reaches it (Splice infrastructure)

```
Robinhood Chain (L2, 4663)
  → onchain data: JSON-RPC · Blockscout index · DEX markets
    → Splice providers: Alchemy · QuickNode · Goldsky · public RPC · Blockscout · CoinGecko · DexScreener · GeckoTerminal · GoPlus · Zerion
      → capabilities: onchain.* · market.* · security.* · wallet.*
        → skills: @splice/onchain · @splice/market
          → agents: MCP · SDK · CLI
```

| Data | Capability | Providers |
| --- | --- | --- |
| Blocks, transactions, receipts, balances, nonce, code, calls, storage, logs, gas | `onchain.*` (RPC) | Alchemy → QuickNode → Goldsky → public RPC |
| Call traces | `onchain.transaction` + traces | QuickNode, Blockscout |
| Token balances, metadata, transfers, holders, verified contracts, counters | indexed | Blockscout, Alchemy |
| ETH and token prices, DEX pools | `market.*` | CoinGecko, GeckoTerminal, DexScreener |
| Token and address security | `security.*` | GoPlus |
| Wallet portfolio | `wallet.portfolio` | Zerion |

The public RPC needs no key, so `splice chain info` works out of the box. Keys for the other
providers unlock indexed and higher-throughput data ([Environment variables](environment-variables.md)).

```sh
splice chain info
splice wallet inspect 0x<address>
splice token inspect 0x<token>
splice market pairs robinhood 0x<token>
```

## Agent capabilities

A skill that declares `onchain.balance`, `onchain.token` or `market.pairs` in
`permissions.capabilities` can use Robinhood Chain data without holding any key or opening a socket
— see [Host capabilities](capabilities.md) and the official `@splice/onchain` and `@splice/market`
skills.

## Security considerations

- **Chain verification.** Every RPC provider must report chain ID 4663 before it is used; one that
  reports another chain is marked `chain_mismatch` and skipped.
- **Read-only.** Splice reads chain data; it holds no wallets, signs nothing and sends no
  transactions.
- **Provider trust.** Results are what the providers return, with provenance (provider, block
  number, fetch time). Splice does not re-execute or independently prove chain state.
- **TLS is never disabled.** Where a network intercepts TLS to `*.robinhood.com`, the public RPC is
  reported as degraded and other providers answer.
- **Independence.** Splice is not affiliated with, endorsed by or sponsored by Robinhood
  Markets, Inc.
