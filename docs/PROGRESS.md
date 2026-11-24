# Progress

Newest first. One entry per phase (see `docs/PHASES.md`).

## Next session: start here

State on Nov 24 evening: phases 0 to 6 merged (PRs #1 to #8), `main` is clean, CI green (contracts, TypeScript, e2e on anvil). Protocol live on Aevum, addresses in the README.

1. **Fund the facilitator wallet first** (needed for any live run on Aevum). `FACILITATOR_PRIVATE_KEY` is in `.env`, address `0x1f95D77ba8FA26CC4B1b19A321b193487ff04FCc`, balance 0. Pick one:
   - Quickest: send 0.3 tQDAY from the deployer (has about 0.99). Load `.env`, then
     `cast send 0x1f95D77ba8FA26CC4B1b19A321b193487ff04FCc --value 0.3ether --rpc-url https://rpc-test.qday.info --legacy --private-key $DEPLOYER_PRIVATE_KEY`.
   - Faucet: https://faucet.qday.info/en needs a browser wallet. In MetaMask: add network (RPC `https://rpc-test.qday.info`, chain ID 44005, symbol tQDAY, explorer `https://explorer-test.qday.info`), then account list, "Add wallet", "Import an account", paste the key from `.env` (never into chat), connect on the faucet and claim.
   - Check with `pnpm check-setup`: the facilitator row should show tQDAY.
2. **Phase 7** (`phase/7-stalls`): demo stalls 1 to 8 (PRD 8.5) in `services/sellers`: one Express server, one `createSeller` per stall, `serveAgentCard` per identity, plus a seed script that registers identities (with an http `agentCardURI`, see D14), stalls and small stakes. Stall 8 (Shady) quotes above its on-chain price and points its card at a different payee; the buyer SDK already refuses both (`OVERPRICED`, `PAYEE_MISMATCH`). Start from `packages/sdk/test/e2e.test.ts`, which already runs one stall per mode with `paid()`.
   - Before starting, decide with the user: LLM stalls need an OpenAI-compatible endpoint (PRD default: local Ollama `qwen2.5`). Check whether Ollama is installed or use a hosted key in `.env`.
   - Seller keys: the seed script needs a funded seller key (stake 0.25 tUSD8 per stall, plus gas). `.env.example` has `SELLER_PRIVATE_KEY`; the user's `.env` doesn't yet.
   - Done when workflows 2 to 6 (PRD section 9) pass end to end on the fork.
3. Still open: gasless `depositWithAuthorization` relay (phase 9 `/wallet`), `app.set("trust proxy", ...)` behind a proxy (phase 10), PRD questions in `docs/QDAY_NOTES.md` (ask on the QDay Discord).

## Phase 6: buyer and seller SDKs (Nov 24)

- `@clawdford/sdk/seller`: `createSeller` + `paid()` Express middleware for `exact`, `license`, `stream` and `task`. Answers 402 with a fresh signed quote; settles exact, license and task through the facilitator before the handler; streams check the voucher locally (channel and session read from chain, agent signature) and meter the cost when the handler writes its headers. Voucher store in SQLite. `settleNow` / `startSettler` claim through the facilitator and finalize closed channels. `submitResult` for tasks, `serveAgentCard`.
- `@clawdford/sdk/buyer`: `createBuyer` + `payingFetch` (402 to sign to retry), guards before signing (session revoked or expired, Confirmation of Payee against the stall and the on-chain agent card, price against the on-chain unit price and the per-call budget), channels that open, top up and close themselves, readable refusal codes (`PAYEE_MISMATCH`, `OVERPRICED`, `CAP_EXCEEDED`, `SESSION_REVOKED`, ...). Returns `{ data, receipt, spent }`.
- Facilitator (option B, D13): `/claim` and `/close` so sellers never need gas, with a 0.01 tUSD8 minimum claim on open channels.
- Decisions D12 (pay-as-you-go streams), D13 (facilitator pays sellers' gas), D14 (agent card from the identity's on-chain URI).
- `packages/testkit`: shared anvil setup (deploy, one stall per mode, funded session) for both e2e suites.
- SDK e2e: exact, license, four metered stream calls with a top up, settler claim, close and refund to the owner, task escrow plus `submitResult`, `OVERPRICED`, `PAYEE_MISMATCH`, revoke. Passes on anvil and on the Aevum fork. CI now runs both e2e suites on anvil.

## Phase 5: x402 package and facilitator (Nov 24)

- Checked the current x402 spec: v2 headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, base64 JSON, CAIP-2 networks. Facts in `docs/QDAY_NOTES.md`; how our payloads differ in D11.
- `packages/aevum`: committed ABIs (`pnpm export-abis` regenerates them from `contracts/out`) and `loadDeployment(chainId)`.
- `packages/x402`: zod schemas for `PaymentRequired`, `PaymentPayload` and facilitator bodies, one shape per scheme (`exact`, `batch-settlement`, `escrow`); header encode/decode; vault EIP-712 domain and types with a test that reads the Solidity typehash strings so they can't drift.
- `services/facilitator`: `/supported`, `/verify` (requirement checks, then the real vault call as `eth_call`; the custom error name is the reason code), `/settle` (same checks, then a legacy tx; returns receipt, channel or task id), `/activity` (recent settles and refusals plus gas balance). Settles run one at a time. SQLite rails (built-in `node:sqlite`) cap settles per IP, per session and overall per UTC day. Refuses anvil keys on Aevum, warns on low tQDAY.
- E2E test (opt in, `make e2e-anvil` / `make e2e-fork`): spawns anvil, runs `Deploy.s.sol`, registers stalls, funds a session, then pays exact through x402 headers, refuses the replay, tampered requirements, an over-cap quote and a revoked session, opens and tops up a channel, escrows a task. Passes on plain anvil and on a fork of Aevum with the real tUSD8.
- 24 TypeScript tests in CI (+6 e2e locally). Contracts unchanged.

## Phase 4: reputation, invariants, fork tests, deploy script (Nov 24)

- `ReputationRegistry`: one rating (1 to 5) per paid receipt, only by the session owner or agent; `average` (x100) and `count` per stall.
- Invariant suite (`test/invariant/`): a handler drives exact pays, disallowed-category pays, channel open / top up / claim / close / finalize, task create / submit / approve / auto release / dispute / resolve / cancel, deposits, withdrawals, time jumps and a rare revoke. 7 invariants hold over 128 runs x 64 calls: vault fully backed (free + channels + escrow), stakes fully backed, total cap, daily cap, no disallowed category paid, no charge after revoke.
- Fork tests (`test/fork/`, opt in with `AEVUM_FORK=true`): real tUSD8 domain, permit deposit, gasless EIP-3009 deposit and a full `payExact`, all passing against `rpc-test.qday.info`.
- Verified the real tUSD8 matches `MockTUSD8` (domain, version "2", 6 decimals, permit and 3009 typehashes). See `docs/QDAY_NOTES.md`.
- `script/Deploy.s.sol` deploys everything and writes `deployments/<chainId>.json` with addresses and deploy block. Verified with legacy txs on a local Shanghai anvil.
- 107 tests (+4 fork tests skipped offline). Coverage 99.4% lines, 97.5% branches.
- Deployed to Aevum testnet at block 4,018,135 (PR #6). Addresses in the README and `deployments/44005.json`. Treasury and arbiter are the deployer key for now.

## Phase 3: vault payment modes (Nov 24)

- Vault source split into `VaultBase`, `VaultChannels`, `VaultTasks`; still one deployed `AgentVault` (22.2 KB runtime).
- Stream: agent-signed `OpenChannel` / `TopUp` (charged against caps), cumulative `Voucher` claims in batches with a receipt per claim, close by owner, agent or agent signature, 10 minute challenge window, `finalizeClose` refund. Revoke starts the window on every open channel (max 16 per session).
- Task: agent-signed `CreateTask` escrow, `submitResult` before the deadline, approve by owner or by agent when allowed (direct or signed), `autoRelease` after a 1 hour review window, owner `dispute`, arbiter `resolve` split, `cancel` refund after the deadline.
- `_refund` credits total spend fully and today's spend only for same-day charges.
- 97 contract tests. Coverage 99.4% lines, 97.4% branches.
- Decisions D7 to D10 logged.

## Phase 2: vault core (Nov 24)

- `AgentVault`: owner balances funded by approve, permit or gasless EIP-3009 `receiveWithAuthorization` (relayed, always credited to the signer).
- Sessions: agent key, per-payment / daily (UTC day) / total caps, expiry, category mask, optional stall allowlist, `agentCanApprove` flag, instant final revoke. `remaining()` view for the MCP `wallet_status` tool.
- `_charge`: the single spend gate. Checks revoked, expired, stall active, category, allowlist, zero amount, per-payment, daily, total and owner balance, then books the spend.
- `payExact`: seller-signed quote + agent-signed intent, both EIP-712 under the vault domain. One payment per quote and per intent nonce. Pays payee minus the 3% fee and writes a receipt. License mode also records `licenses[owner][stall]`.
- 37 vault tests (balances, sessions, every `_charge` rule, signatures and replay, cross-chain signatures, license) plus a cap fuzz test across UTC days.
- Coverage: 98.8% lines overall, `AgentVault` 98.7%.
- Decisions D4 to D6 logged.

## Phase 1: registries (Nov 24)

- `MockTUSD8`: 6 decimals, EIP-712 domain ("tUSD8", "2"), EIP-2612 permit, EIP-3009 transfer / receive / cancel authorization.
- `IdentityRegistry`: minimal ERC-8004-style identity. Unique domain per identity, controller can update the agent card or hand over control.
- `StallRegistry`: stalls tied to an identity, staked in tUSD8 (approve or permit, permit front-run safe). Price, payee, quote key and endpoint updates. Unstake with cooldown; stake under cooldown stays slashable. Arbiter slashes to the harmed buyer or the treasury. Stalls below `minStake` go inactive. Paginated `listStalls` and a lean `paymentInfo` view for the vault.
- 32 tests including a stake accounting fuzz test. Coverage: 98.9% lines overall, `StallRegistry` 100% lines and branches.
- All three contracts pass the Shanghai opcode check. CI now also runs `forge fmt --check`.

## Phase 0: scaffold (Nov 24)

- pnpm workspace, shared `tsconfig.base.json`.
- Foundry project in `contracts/`: solc 0.8.24, `evm_version = "shanghai"`, OpenZeppelin pinned to v5.1.0, forge-std v1.9.4.
- `tools/check-shanghai.mjs`: fails the build if runtime bytecode uses BLOBHASH, BLOBBASEFEE, TLOAD, TSTORE or MCOPY. Self-tested.
- `packages/aevum`: viem chain definitions (Aevum 44005, fork 440050, anvil 31337), tUSD8 constants, `getLogsChunked` (1,000-block chunks, tested).
- `pnpm check-setup` prints chain id, head block and balances for each role key in `.env`. Verified live against `rpc-test.qday.info` (chain id 44005).
- Makefile targets: `test`, `anvil`, `fork`, `deploy-fork`, `deploy-aevum`, `check-shanghai`, `coverage`. Root pnpm scripts cover the same on machines without make.
- CI: forge build + test, Shanghai check, typecheck, vitest.

Open: wallets funded from faucet (needs the user: web faucet + Discord `/faucet`).
