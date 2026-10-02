# @splice/onchain

Robinhood Chain (chain id 4663) data for agents — through the **Splice capability broker**. The
package declares host capabilities instead of network access:

```json
"permissions": { "network": [], "env": [], "capabilities": ["onchain.balance", "onchain.transaction", "onchain.token"] }
```

The Splice host answers from its RPC providers (chain id verified live), Blockscout, CoinGecko and
GoPlus with its own keys; the package never sees a key or opens a socket.

## Tools

| Tool | Input | Host capability |
| --- | --- | --- |
| `balance` | `address` | `onchain.balance` — native ETH, pinned to a block |
| `transaction` | `hash` | `onchain.transaction` — transaction + receipt |
| `token` | `address` | `onchain.token` — metadata, supply, holders, price, pools, security (one section each) |

Outputs are the host results: `LIVE` / `CACHED` with provenance (provider, block number, fetch
time), or `UNAVAILABLE` / `ERROR` with a code and reason. Fields a provider does not return are
absent — never zero or invented.

## Usage

```sh
splice add @splice/onchain --accept-permissions
splice run onchain.balance address=0x948951006b81b5dc954a18b639918a768447a66f
splice run onchain.token address=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
```
