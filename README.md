# Clawdford Market

**Any AI agent can buy any AI service, paid per request in tUSD8, with an owner-set budget it can never exceed.**

Built for the Aevum Builder Challenge #1 (QDay), track Native AI Assistants. Settles on the QDay Aevum testnet (chain ID 44005) in tUSD8. Named after Crawford Market in Mumbai: one roof, hundreds of stalls, open prices.

> Status: every workflow ran on the Aevum testnet with real tUSD8 (Nov 25, [run with explorer links](docs/demo-runs/2026-11-25-aevum.md)). Contracts, x402 facilitator, SDKs, 8 demo stalls, MCP server and web app are done (phases 0 to 10 part 2); hosting and the submission are next. See [docs/PHASES.md](docs/PHASES.md) and [docs/PROGRESS.md](docs/PROGRESS.md).

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

### Deployed on Aevum testnet (chain 44005)

Deploy block 4,018,135, from source commit [`09a27a4`](https://github.com/DewashishCodes/clawdford-market-aevum/tree/09a27a468ea4690161af9d809834bc3663c09ed7). Full record in [`deployments/44005.json`](deployments/44005.json).

| Contract | Address |
|---|---|
| `AgentVault` | `0x88f4CceafDF6c90664117CC8E0A3bB3C4C275BBE` |
| `StallRegistry` | `0xfBF14819a42dA717b779b6A900DDA461CDBDAD70` |
| `IdentityRegistry` | `0x3580f1d5Bf7eB3A82a043545e748EA5Be8128bf8` |
| `ReputationRegistry` | `0xE93A44e253C7d5697f1b4E480f7F54B1A7dfAfC3` |
| tUSD8 (QDay token) | `0x456569838f1d43009A91ebA4263147Afd7233483` |

## Repo layout

```
contracts/          Foundry project (src, test, script); Shanghai, OZ 5.1.0
packages/aevum/     viem chain defs, tUSD8 constants, ABIs, deployments loader, getLogsChunked, check-setup
packages/x402/      x402 v2 schemas, header codec, vault EIP-712 types
packages/sdk/       buyer (payingFetch + guards) and seller (paid() middleware, settler) SDKs
packages/testkit/   test-only anvil setup shared by the e2e suites
services/facilitator/  /supported /verify /settle /claim /close /activity, SQLite rails
services/sellers/   demo stalls 1 to 8 on one server, seed script
mcp/                MCP server (stdio) for Claude Code and Codex; holds only the session key
web/                Next.js app: market, owner console, seller onboarding, tasks, activity
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

End to end (each spawns anvil, deploys and pays over HTTP with x402 headers; run them one at a time):
from `services/facilitator/`: `FACILITATOR_E2E=anvil pnpm exec vitest run test/e2e.test.ts`;
from `packages/sdk/`: `SDK_E2E=anvil pnpm exec vitest run test/e2e.test.ts`;
from `services/sellers/`: `SELLERS_E2E=anvil pnpm exec vitest run test/e2e.test.ts` (PRD workflows 2 to 6 against the demo stalls);
from `mcp/`: `MCP_E2E=anvil pnpm exec vitest run test/e2e.test.ts` (every MCP tool through a real MCP client);
from `web/`: `WEB_E2E=anvil pnpm exec vitest run test/e2e.test.ts` (the web app's chain indexer and queries). Use `fork` instead of `anvil` for a fork of Aevum with the real tUSD8.

Run the facilitator: set `FACILITATOR_PRIVATE_KEY` (and `CHAIN_ID`) in `.env`, then `pnpm --filter @clawdford/facilitator start` (port 4020).

Run the demo stalls: set `SELLER_PRIVATE_KEY` (holding 2 tUSD8 for 8 stakes of 0.25, plus tQDAY for gas), `REVIEW_TOKEN`, `SELLERS_PUBLIC_URL` and an OpenAI-compatible LLM (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`; local Ollama `qwen2.5` by default) in `.env`. Then `pnpm --filter @clawdford/sellers seed` once (registers identities and stalls, writes `deployments/stalls-<chainId>.json`) and `pnpm --filter @clawdford/sellers start` (port 4030). `GET /catalog` lists the stalls.

| # | Stall | Mode | Price (tUSD8) | Route |
|---|---|---|---|---|
| 1 | LexModel chat | stream | 0.002 / 1k tokens | `POST /s/lexmodel` `{messages, maxTokens?}` |
| 2 | Clause risk dataset | stream | 0.0005 / row | `GET /s/clauses?risk=&type=&offset=&limit=` |
| 3 | Case notes search | exact | 0.001 / query | `GET /s/cases?q=` |
| 4 | Risk memo writer skill | license | 0.2 | `GET /s/risk-memo-skill` |
| 5 | Draft judge | exact | 0.001 / call | `POST /s/judge` `{draft, rubric?}` |
| 6 | Batch embeddings | task | 0.05 / job | `POST /s/embeddings` `{texts}` |
| 7 | Human review board | task | 0.1 / task | `POST /s/review` `{document, question?}`; reviewer: `GET /s/review/queue`, `POST /s/review/:taskId/decision` (Bearer `REVIEW_TOKEN`) |
| 8 | Shady stall (demo fixture) | exact | quotes 10x | `GET /s/shady` |

Use the market from Claude Code or Codex: see [`mcp/README.md`](mcp/README.md). To try everything locally, `pnpm --filter @clawdford/mcp dev-stack` starts a fork of Aevum with the facilitator, the seeded stalls and a funded session, and writes `mcp/dev-mcp.json` for `claude --mcp-config`.

Run the web app against Aevum: `pnpm --filter @clawdford/web dev` (port 3000; `CHAIN_ID`, `FACILITATOR_URL` and optional `RPC_URL` from the environment, see `.env.example`). Connect MetaMask with "Add Aevum to wallet". Pages: `/` (stats and latest receipts), `/market`, `/stall/[id]`, `/wallet` (owner console: gasless deposit, sessions with caps, live spend, Revoke, channels, ratings), `/sell` (identity, 402 check, stake and list), `/tasks` (task board and the human review queue), `/activity` (live feed). Locally, `pnpm --filter @clawdford/mcp dev-stack` prints the line that starts it against a fork with a dev wallet, no MetaMask needed.

Demo stalls 1 to 8 are listed on Aevum (`deployments/stalls-44005.json`). Every PRD workflow ran on Aevum with real tUSD8: [docs/demo-runs/2026-11-25-aevum.md](docs/demo-runs/2026-11-25-aevum.md).

Fork tests against real tUSD8: `cd contracts && AEVUM_FORK=true forge test --match-path "test/fork/*"`.

Local deploy: `anvil --hardfork shanghai`, then `DEPLOYER_PRIVATE_KEY=<anvil key> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --legacy` from `contracts/`.

With make: `make test`, `make fork`, `make deploy-fork`, `make deploy-aevum`, `make facilitator`, `make e2e-anvil`, `make e2e-fork` (reads the root `.env`).

## Docs

- [Product requirements](docs/PRD.md)
- [Phase plan](docs/PHASES.md) and [progress](docs/PROGRESS.md)
- [Decisions](docs/DECISIONS.md) and [QDay notes](docs/QDAY_NOTES.md)

## License

MIT, see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
