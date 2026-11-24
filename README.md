# Clawdford Market

**Any AI agent can buy any AI service, paid per request in tUSD8, with an owner-set budget it can never exceed.**

Built for the Aevum Builder Challenge #1 (QDay), track Native AI Assistants. Settles on the QDay Aevum testnet (chain ID 44005) in tUSD8. Named after Crawford Market in Mumbai: one roof, hundreds of stalls, open prices.

> Status: smart contracts done and tested (phases 0 to 4). Off-chain pieces (x402 package, facilitator, SDKs, demo stalls, MCP server, web app) come next. See [docs/PHASES.md](docs/PHASES.md) and [docs/PROGRESS.md](docs/PROGRESS.md).

## The problem

- Agents can't sign up, pass KYC or hold a card, so every paid API needs a human first.
- Giving an agent a wallet is dangerous: a leaked key, a loop or a prompt injection can drain it.
- Builders have no checkout an agent can use, and tiny payments die on fees.

## How it works

1. **Agent Vault with session keys.** The owner deposits tUSD8 and grants an agent a session: per-payment cap, daily cap, total cap, expiry, allowed categories, optional stall allowlist. The owner can revoke it at any moment. Every payment is checked against these rules in the contract.
2. **x402 payments, gasless for the agent.** A service answers `402 Payment Required` with a seller-signed quote. The agent signs a payment intent with its session key. A facilitator submits it and pays the gas.
3. **Payment modes per stall:** `exact` (one payment per call), `stream` (payment channel with cumulative vouchers settled in batches), `task` (escrow until the buyer accepts), `license` (one-time purchase recorded on chain).

Trust layer: sellers register an identity and stake tUSD8; buyers check that the quote's payee matches the payee registered on chain (Confirmation of Payee); one rating per paid receipt.

## Contracts

| Contract | What it does |
|---|---|
| `AgentVault` | Owner balances (approve, permit, gasless EIP-3009), sessions, the `_charge` safety check, exact + license payments (`vault/VaultBase.sol`), stream channels (`vault/VaultChannels.sol`), task escrow (`vault/VaultTasks.sol`) |
| `StallRegistry` | Staked service listings, unstake cooldown, arbiter slashing |
| `IdentityRegistry` | Minimal ERC-8004-style seller identity with an agent card URI |
| `ReputationRegistry` | One rating per paid receipt |
| `MockTUSD8` | Local stand-in for tUSD8 (same domain, permit and EIP-3009) |

Aevum rules we follow: Shanghai EVM (OpenZeppelin pinned to v5.1.0, CI scans bytecode for Cancun opcodes), legacy transactions, `eth_getLogs` in 1,000-block chunks, HTTPS polling only.

Testing: 107 unit, fuzz and invariant tests plus fork tests against the real tUSD8. Coverage 99.4% lines, 97.5% branches.

Addresses on Aevum: not deployed yet. They will be listed here and in `deployments/44005.json`.

## Repo layout

```
contracts/          Foundry project (src, test, script); Shanghai, OZ 5.1.0
packages/aevum/     viem chain defs, tUSD8 constants, getLogsChunked, check-setup
tools/              Shanghai bytecode checker
docs/               PRD, phases, progress, decisions, QDay notes
deployments/        <chainId>.json written by the deploy script
```

## Run it

Requirements: Node 20+, pnpm, Foundry.

```sh
pnpm install
cd contracts && forge install && forge test      # contract tests
cd .. && pnpm typecheck && pnpm test             # TypeScript checks
pnpm check-shanghai                              # build + Cancun opcode scan
pnpm check-setup                                 # Aevum RPC + balances for keys in .env
```

Fork tests against real tUSD8: `cd contracts && AEVUM_FORK=true forge test --match-path "test/fork/*"`.

Local deploy: `anvil --hardfork shanghai`, then `DEPLOYER_PRIVATE_KEY=<anvil key> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --legacy` from `contracts/`.

With make: `make test`, `make fork`, `make deploy-fork`, `make deploy-aevum` (reads the root `.env`).

## Docs

- [Product requirements](docs/PRD.md)
- [Phase plan](docs/PHASES.md) and [progress](docs/PROGRESS.md)
- [Decisions](docs/DECISIONS.md) and [QDay notes](docs/QDAY_NOTES.md)

## License

MIT, see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
