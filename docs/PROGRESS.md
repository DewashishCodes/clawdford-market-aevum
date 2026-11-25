# Progress

Newest first. One entry per phase (see `docs/PHASES.md`).

## Next session: start here

State on Nov 25 night: phases 0 to 9 merged, CI green (contracts, TypeScript, web build, e2e on anvil for facilitator, SDK, sellers, MCP and web). Protocol live on Aevum, addresses in the README. Facilitator wallet funded with 0.3 tQDAY from the deployer (tx `0x6007077b...3322`).

1. **Seed the demo stalls on Aevum** (waiting on the user):
   - Add `SELLER_PRIVATE_KEY` to `.env` (a fresh key, not an anvil one) and fund it with 2 tUSD8 (8 stakes of 0.25) plus about 0.1 tQDAY. The deployer holds about 5 tUSD8 and 0.69 tQDAY.
   - Set the LLM in `.env`: any OpenAI-compatible endpoint (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`). The user will provide a Groq or Gemini key; examples in `.env.example`.
   - Set `REVIEW_TOKEN` and `SELLERS_PUBLIC_URL`. The seed writes that URL into the on-chain agent cards and endpoints, so seed once the public URL exists (phase 10), or update the identities' `agentCardURI` and stalls' endpoints after.
2. **Phase 10** (`phase/10-live`): Docker compose for facilitator + sellers (+ web), a VPS with https for facilitator and sellers (the web server only fetches public https stall URLs on Aevum, D19), web on Vercel (`DEPLOYMENTS_DIR` or bundle `deployments/44005.json`; indexer is in memory per process, see `shortcut:` in `web/lib/server/indexer.ts`), `app.set("trust proxy", ...)` in the facilitator behind the proxy, then run every workflow on Aevum and record explorer links.
3. Still open: PRD questions in `docs/QDAY_NOTES.md`. The SDK e2e stream test failed once in six runs locally (likely its 5 second close window against the real clock); rerun if CI flakes there.

## Phase 9: web app (Nov 25)

- `web/`: Next.js 15 (App Router) + Tailwind 4, one teal accent, light and dark. Pages: `/` (hero, how it works, live stats, latest receipts), `/market` (filters by text, category, mode and max price; rating; Confirmation of Payee badge from the agent card), `/stall/[id]` (price, usage, payee, identity, stake, receipts, ratings), `/wallet` (owner console), `/sell`, `/tasks`, `/activity` (polls every 3 s).
- Owner console: gasless deposit (EIP-3009 signature relayed by the new facilitator `POST /deposit`) or approve + deposit, withdraw, create a session (caps, expiry, categories, stall allowlist, agent may approve; the agent key is generated in the browser and the Claude Code and Codex setup is shown once), live spend bars, Revoke, channel Close and Get refund (D20), rating receipts (D16).
- `/sell`: register an identity, then the 402 check (endpoint answers 402 with an x402 quote paying the payee through this vault, and the agent card names the same payee) before stake and list. `/tasks`: task board and the human review queue through a proxy route; the reviewer's token stays in the browser.
- Server: in-memory indexer over all protocol events from the deploy block (1,000-block chunks, 6 in parallel), receipts derived from `Paid`, `ChannelClaimed` and `TaskReleased`, facilitator refusals merged into `/activity`. Server fetches of on-chain URLs are limited to public https on Aevum (D19).
- Wallet: plain viem over `window.ethereum` with "Add Aevum to wallet", legacy txs, simulate first for readable contract errors; `DEV_WALLET_KEY` on local chains only (D18).
- `pnpm --filter @clawdford/mcp dev-stack` now also leaves the owner 0.4 tUSD8 in the wallet and prints the web start line; `call-tool` runs one MCP tool as the dev agent.
- Verified on the Aevum fork in Chrome with the dev wallet plus the MCP agent: workflows 1 (gasless deposit, session with setup snippet), 2 to 4 and 6 (agent pays, shady refused), 5 (reviewer approves in `/tasks`, agent verifies and releases), 7 (Revoke, channels enter the window, next agent call `SESSION_REVOKED`, refund) and 8 (identity, 402 check pass and fail, stake and list stall 13). Fixed along the way: dev wallet reconnect, review message, Codex snippet `RPC_URL`, orphaned channels (D20), activity order within one block time.
- `WEB_E2E=anvil|fork`: 7 tests of the server queries against the seeded market, plus a URL guard unit test. CI runs it on anvil and builds the web app.

## Phase 8: MCP server (Nov 25)

- `mcp/`: stdio MCP server (`@modelcontextprotocol/sdk` 1.32) holding only the session key, configured by env (never reads the repo `.env`). Tools: `market_search` (stalls from chain, names and usage from each stall's `metadataURI`, ratings, whether the session's category mask allows it), `wallet_status`, `call_service`, `buy_license`, `download_skill` (installs `SKILL.md`, safe folder names, never overwrites), `create_task`, `get_task` (verifies the result against the on-chain hash), `approve_task`, `rate_service`, `close_channels`. Every result carries a `budget` block; refusals return the readable code with `charged: "nothing"`. Pays only a stall's registered endpoint.
- Facilitator `POST /approve` relays `approveWithSig`; buyer SDK `approveTask` (D17). Ratings need gas on the agent key (D16).
- Demo catalog entries now carry a `usage` line for agents. The demo market test setup moved to `services/sellers/test/market.ts` (shared by the sellers and MCP e2e).
- `pnpm --filter @clawdford/mcp dev-stack`: fork of Aevum with the facilitator, seeded stalls and a funded session; writes `mcp/dev-mcp.json`.
- E2E (`MCP_E2E=anvil|fork`): 11 tests through a real MCP client, including Shady refused (`PAYEE_MISMATCH`), task approved and released, and revoke (`SESSION_REVOKED`). Passes on anvil and on the Aevum fork; CI runs it on anvil. Also checked the server over real stdio via `pnpm --silent start` against live Aevum.
- Done criterion met: headless Claude Code (Sonnet) given the PRD demo prompt with only these tools searched the market, paid six stalls (dataset stream, case search, LexModel stream, skill license, draft judge, human review with approval), closed its channels and wrote the memo with a cost breakdown, spending 0.3065 of a 1 tUSD8 budget. Transcript in `docs/demo-runs/2026-11-25-fork.md`.

## Phase 7: demo stalls and seed script (Nov 25)

- `services/sellers`: one Express server with all eight PRD 8.5 stalls, each a `createSeller` + `paid()` route: LexModel chat (stream, metered by the provider's token count), clause risk dataset (stream, per row, bundled CSV), case notes search (exact), risk memo writer skill (license, a real skill file), draft judge (exact, LLM grader), batch embeddings (task, delivered by `submitResult` on its own), human review board (task, reviewer queue behind a bearer token) and the Shady stall (demo fixture, 10x quote, card names another payee).
- Seed (`pnpm --filter @clawdford/sellers seed`): registers two identities (demo and shady) with http agent cards (D14) and the eight stalls at `minStake`, writes `deployments/stalls-<chainId>.json`. Refuses anvil keys on Aevum.
- LLM stalls take any OpenAI-compatible endpoint (D15). Inputs are validated before the 402, so nobody pays for a rejected request. Task result URLs serve the exact bytes whose keccak256 is the on-chain `resultHash`.
- `GET /catalog` lists the stalls; stall `metadataURI`s point at it.
- Testkit: `fund(to, amount)` helper (mint on anvil, transfer from the Aevum deployer on the fork).
- E2E (`SELLERS_E2E=anvil|fork`): workflows 2 to 6 with a fake LLM: case search and judge with receipts, LexModel and dataset streams with a settler claim, close and refund, license purchase recorded on chain, human review approved then released by the owner, embeddings job delivered, Shady refused with `PAYEE_MISMATCH`, payment above the session cap refused with `CAP_EXCEEDED`. 10 tests pass on anvil and on the Aevum fork. CI runs it on anvil.

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
