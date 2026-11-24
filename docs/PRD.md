# Clawdford Market on Aevum: Product Requirements Document

**Build target:** Aevum Builder Challenge #1 (QDay, on DoraHacks), track **Native AI Assistants**
**Network:** QDay Aevum Testnet, chain ID 44005, settlement in **tUSD8**
**Submission deadline:** Dec 11, 08:00 UTC (13:30 IST). Feature freeze Dec 10, 12:00 IST.
**Demo Day:** Dec 15, 06:00 UTC (11:30 IST), live 3 to 5 minute demo if in the top 5.

---

## 0. Instructions for Claude Code (read first)

1. This is a **new repository built from scratch**. Write every file fresh. Do not copy code from any other repository. The one exception is the official **Aevum Starter Kit** (`github.com/qday-io/aevum-starter-kit`, MIT, PQA Labs). You may reuse parts of it, but only with attribution: keep its copyright notice, put a comment above each borrowed snippet naming the source repo, author and license, and list it in `NOTICE.md`.
2. Work milestone by milestone (section 12). Commit small and often with clear messages. Each milestone ends with passing tests and a short status note in `docs/PROGRESS.md`.
3. Read section 4 (Aevum platform rules) before writing any contract or chain code. Breaking these rules gives bugs that only show up on the real testnet.
4. Never commit private keys or `.env` files. Use `.env.example` with placeholders.
5. When something in this PRD is marked **[VERIFY]**, check the live source (QDay docs, the Discord answers in `docs/QDAY_NOTES.md`, the x402 spec at x402.org) before building it. Write what you found into `docs/QDAY_NOTES.md`.
6. If the PRD and reality disagree (an endpoint doesn't exist, an opcode fails), choose the simplest working option, note it in `docs/DECISIONS.md`, and keep going.

### Key links

| What | Link |
|---|---|
| Challenge page (register + submit BUIDL) | https://dorahacks.io/hackathon/qday/detail |
| Challenge rules, tracks, criteria, FAQ | https://qday.io/builder-challenge |
| Aevum Starter Kit (MIT) | https://github.com/qday-io/aevum-starter-kit |
| QDay GitHub org | https://github.com/qday-io |
| QDay website / build hub (x402, paymaster, agent wallets status) | https://qday.io/ · https://qday.io/build |
| Developer guide | https://wiki.qday.info/Knowledge/technical/developer-guide/getting-started/ |
| JSON-RPC reference | https://wiki.qday.info/Knowledge/technical/reference/json-rpc-api/ |
| Chain params / add network | https://wiki.qday.info/Knowledge/reference/chains · https://wiki.qday.info/guide/start/add-network |
| Community guide + whitepaper | https://community.qday.io/guide/ · https://community.qday.io/guide/qday-whitepaper.html |
| Portal dashboard | https://portal.qday.io/zh-HK/dashboard |
| RPC (chain 44005) | https://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| tUSD8 token | https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483 |
| Web faucet (tQDAY) | https://faucet.qday.info/en |
| Discord (faucet `/faucet`, support, ask open questions) | https://discord.gg/bYPhjmrSfK |
| x402 spec | https://x402.org · https://github.com/coinbase/x402 |
| ERC-8004 (agent identity / reputation) | https://eips.ethereum.org/EIPS/eip-8004 |
| EIP-3009 / EIP-2612 | https://eips.ethereum.org/EIPS/eip-3009 · https://eips.ethereum.org/EIPS/eip-2612 |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
| OpenZeppelin v5.1.0 (pin this) | https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.1.0 |

Some QDay docs pages block automated fetching. If a page won't load, ask the user to paste it.

---

## 1. One-liner

**Any AI agent can buy any AI service, paid per request in tUSD8, with an owner-set budget it can never exceed.**

Named after Crawford Market in Mumbai: one roof, hundreds of stalls, open prices, everyone welcome.

## 2. Problem

- **Agents can't pay.** An agent can't sign up, pass KYC or hold a card. Every paid API needs a human to set up keys and billing first.
- **Giving an agent a wallet is dangerous.** A leaked key, a loop or a prompt injection can drain it. Owners need hard limits enforced on chain, not promises in a prompt.
- **Builders can't sell to agents.** A niche model, a dataset or a tool has no checkout that an agent can use.
- **Tiny payments die on fees.** A $0.002 call costs more than that to process on cards, or as one on-chain transaction per call.
- **Strangers don't trust each other.** Agents need to know the seller is who they claim, that they'll get what they paid for, and that the price is the price.

## 3. Solution overview

A marketplace of "stalls" (paid AI services) on Aevum, with three pieces that make agent spending safe:

1. **Agent Vault with session keys.** The owner deposits tUSD8 and grants an agent a session: per-payment cap, daily cap, total cap, expiry, allowed categories. The owner can revoke it at any moment. Every payment is checked against these rules **in the contract**.
2. **x402 payments, gasless for the agent.** Services answer `402 Payment Required` with a seller-signed quote. The agent signs a payment intent with its session key. A facilitator submits it and pays the gas. The agent never holds tQDAY.
3. **Three payment modes per stall:**
   - `exact`: one payment per call (tools, single queries)
   - `stream`: a payment channel with cumulative signed vouchers, settled in batches (inference per token, data per row)
   - `task`: escrow until the buyer accepts the delivery (compute jobs, human tasks)
   - plus `license`: a one-time purchase recorded on chain (skills, model weights)

Trust layer: sellers register an on-chain identity, stake tUSD8, and get **Confirmation of Payee** (the buyer SDK checks that the payee in the 402 matches the payee registered on chain and published on the seller's domain). Buyers with a receipt can leave one rating per receipt (reputation).

The flagship demo: an agent in Claude Code, connected through an **MCP server**, shops across stalls to finish a real task within a budget, gets blocked when it tries to overspend, and stops within seconds when the owner hits **Revoke**.

## 4. Aevum platform rules (hard constraints)

| Rule | What to do |
|---|---|
| Chain ID 44005, RPC `https://rpc-test.qday.info`, explorer `https://explorer-test.qday.info` | Define Aevum as a viem custom chain in `packages/aevum`. |
| Gas token tQDAY (18 decimals), ~1 gwei | Facilitator and seller nodes hold small tQDAY balances. Agents hold none. |
| tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals, EIP-2612 `permit` + EIP-3009 (`transferWithAuthorization`, `receiveWithAuthorization`), EIP-712 domain `name "tUSD8"`, `version "2"` | Use the real token on Aevum. Write a `MockTUSD8` (same decimals, domain, permit and 3009 functions) for local tests. |
| **Shanghai EVM.** No `MCOPY`, `TSTORE`/`TLOAD` or blob opcodes. Cancun code deploys fine and then reverts with `invalid opcode`. | `evm_version = "shanghai"` in `foundry.toml`. Pin **OpenZeppelin v5.1.0** (later versions use `mcopy`). No `*Transient` contracts. Add a build check that scans bytecode for Cancun opcodes (the starter kit has `tools/check-shanghai.mjs`; reuse it with attribution). Run anvil with `--hardfork shanghai`. |
| **Legacy transactions** | `forge script ... --legacy`; `type: "legacy"` in viem. |
| **`eth_getLogs` limited to 1,000 blocks** | All event reads go through a `getLogsChunked` helper that starts from the stored deploy block. |
| **HTTPS RPC; don't rely on WebSocket** | Poll with viem `http()` transports. |
| **Explorer verification not working yet** | Publish contract addresses plus a link to the exact source commit in the README and `deployments/44005.json`. |
| Block timestamps have 1-second resolution | Fine for expiry and challenge windows. Don't design anything sub-second on chain. |
| Faucet is small (web faucet: 5 tQDAY per 24h; Discord `/faucet`: 1 tQDAY + 5 tUSD8, once) | **Price everything tiny.** The whole demo must run on ~5 tUSD8 total. Stall prices are 0.0005 to 0.3 tUSD8. Minimum seller stake 0.25 tUSD8. Use a local **fork** (`anvil --fork-url ... --hardfork shanghai --chain-id 440050`) with `deal` for unlimited balances during development. |
| All settlement must happen on Aevum. Test tokens only; no new token is issued or promised. | Everything, including stakes, is tUSD8. **No project token.** |
| Permissive license | MIT. `LICENSE`, `NOTICE.md` with third-party deps and licenses. |

## 5. Users

- **Owner:** a person or team who funds an agent, sets its limits and watches what it spends.
- **Agent (buyer):** Claude Code, Codex or any program using the buyer SDK. It holds only a session key.
- **Seller:** anyone with an HTTP endpoint (model, dataset, tool, skill, compute, human service) who wraps it in the seller SDK.
- **Facilitator:** a service that checks and submits payments and pays gas. Trusted for liveness only: it can delay or refuse, but it can never move funds outside the owner's rules.
- **Arbiter:** resolves task disputes and slashes stakes. For the MVP, this is an admin address. The contract design should make it replaceable.

## 6. Architecture

```
                         ┌──────────────────────────────────────────────┐
 Claude Code / Codex ──▶ │ mcp/  (MCP server, holds session key only)   │
                         └──────────────┬───────────────────────────────┘
                                        │ payingFetch (buyer SDK)
                                        ▼
 ┌──────────────┐  402 + signed quote  ┌───────────────────────────────┐
 │ seller stalls│ ◀──────────────────▶ │ packages/sdk (buyer + seller) │
 │ services/    │  PAYMENT-SIGNATURE   └──────────────┬────────────────┘
 │ sellers      │                                     │ /verify /settle
 └──────┬───────┘                                     ▼
        │ settle vouchers               ┌───────────────────────────────┐
        │                               │ services/facilitator (pays gas)│
        ▼                               └──────────────┬────────────────┘
 ┌──────────────────────────── Aevum (44005) ──────────▼────────────────┐
 │ AgentVault · StallRegistry · IdentityRegistry · ReputationRegistry   │
 │ (channels, escrow and licenses live in AgentVault)       tUSD8       │
 └──────────────────────────────────────────▲──────────────────────────┘
                                            │ polling + chunked logs
                              web/ (Next.js: market, wallet, sell, activity)
```

### Repo layout (pnpm workspace)

```
contracts/            Foundry project (src, test, script); Shanghai, OZ 5.1.0
packages/aevum/       chain def, addresses, ABIs, getLogsChunked, EIP-712 types
packages/x402/        shared x402 types, header encode/decode, quote + intent schemas
packages/sdk/         buyer (payingFetch, budget guard, CoP check) + seller (paid() middleware, voucher store, settler)
services/facilitator/ HTTP service: /supported /verify /settle, persistent rate limits (SQLite)
services/sellers/     demo stalls behind one Express server, plus seed script
mcp/                  MCP server for Claude Code / Codex
web/                  Next.js app
docs/                 architecture, workflows, QDAY_NOTES, DECISIONS, PROGRESS, demo script
docker-compose.yml    facilitator + sellers + web (+ optional ollama)
```

Stack: Node 20+, TypeScript, pnpm, Foundry, solc 0.8.24, OpenZeppelin 5.1.0, viem, wagmi + RainbowKit (or plain injected connector), Next.js (App Router), Tailwind, Express, `@modelcontextprotocol/sdk`, zod, better-sqlite3, vitest.

## 7. Smart contracts

All amounts are tUSD8 base units (6 decimals). Platform fee 3% (`feeBps = 300`, capped at 10% in code) goes to `treasury` on every seller payout. Use `ReentrancyGuard` (storage version), `SafeERC20`, `EIP712`, `ECDSA`, custom errors and events for every state change. Target ≥90% line coverage on the contracts.

### 7.1 `IdentityRegistry` (ERC-8004-style identity) [VERIFY]

If QDay publishes official ERC-8004 identity and reputation registries on Aevum, use those and drop 7.1 and 7.4. Otherwise build a minimal version:

- `register(string domain, string agentCardURI) → uint256 identityId`. The caller becomes the controller.
- `update(identityId, agentCardURI)`, `setController(...)`.
- Agent card JSON lives at `https://<domain>/.well-known/agent-card.json` and includes `{ identityId, name, payee, stalls[] }`.

### 7.2 `StallRegistry`

```
struct Stall {
  address owner;        // seller admin
  address payee;        // where money goes (Confirmation of Payee target)
  address quoteSigner;  // key that signs 402 quotes
  uint256 identityId;
  uint8   category;     // 0 inference, 1 data, 2 tool, 3 knowledge, 4 skill, 5 weights, 6 compute, 7 human, 8 eval, 9 outcome
  uint8   mode;         // 0 exact, 1 stream, 2 task, 3 license
  uint128 unitPrice;    // per unit
  string  unit;         // "call", "1k tokens", "row", "job", "license"
  string  endpoint;     // https URL
  string  metadataURI;  // name, description, tags, example request
  uint128 stake;
  bool    active;
}
```

- `createStall(...)` pulls the stake (≥ `minStake`, default 0.25 tUSD8) with permit or approve.
- `updatePrice`, `setActive`, `addStake`, `requestUnstake` → `withdrawStake` after a 1-hour cooldown (configurable; short for demos).
- `slash(stallId, amount, reason)` arbiter only. Slashed funds go to the harmed buyer or the treasury.
- Views for the web app and SDK: `getStall`, `stallCount`, paginated `listStalls(offset, limit)`.

### 7.3 `AgentVault` (the core)

One contract holds every owner's balance. It enforces session rules for all three payment modes.

**Balances**
- `deposit(amount)` (approve), `depositWithPermit(...)`, `depositWithAuthorization(...)` (EIP-3009 `receiveWithAuthorization`; makes funding gasless through the facilitator).
- `withdraw(amount)` owner only, from the free balance.

**Sessions**
```
struct Session {
  address owner;
  address agentKey;       // session public address; agent holds this private key only
  uint128 perPaymentCap;
  uint128 dailyCap;       // rolling 24h or calendar day (UTC); document which
  uint128 totalCap;
  uint128 spentTotal;
  uint64  expiry;
  uint32  categoryMask;   // bit i = category i allowed
  bool    revoked;
}
```
- `createSession(...)`, `revokeSession(id)` (owner, immediate), `updateCaps(...)` (can only tighten while active, or owner re-grants).
- Optional allowlist: `setStallAllowed(sessionId, stallId, bool)`. If any stall is allowlisted, only allowlisted stalls can be paid.
- Every spend path calls one internal `_charge(session, stall, amount)`. It checks: not revoked, not expired, stall active, category allowed, allowlist, `amount ≤ perPaymentCap`, daily cap, total cap, owner balance. Then it updates the counters. **This one function is the safety story. Test it hardest.**

**Mode `exact` (and `license`)**
- Seller-signed `Quote { stallId, amount, resourceHash, buyerSession, validBefore, quoteNonce }` (EIP-712, signed by `stall.quoteSigner`).
- Agent-signed `PaymentIntent { quoteHash, sessionId, validBefore, nonce }` (EIP-712, signed by `session.agentKey`).
- `payExact(quote, quoteSig, intent, intentSig)` can be called by anyone (normally the facilitator). It checks both signatures, both deadlines, unused nonces and `_charge`. Then it pays the payee minus the fee and emits `Paid(receiptId, sessionId, stallId, amount, resourceHash)`.
- Binding the payment to a seller-signed quote fixes the starter kit's "pay any order with any amount" weakness. The seller can't be underpaid, and nobody can redirect funds to a payee that isn't registered.
- For `license` mode, the same function also records `licenses[owner][stallId] = true` and emits `Licensed`.

**Mode `stream` (payment channels, x402 batch settlement)**
- `openChannel(sessionId, stallId, deposit, intentSig)` agent-signed, relayed. `_charge` the deposit (counts against caps when opened). Funds move from the owner balance into the channel.
- Off chain, the agent signs `Voucher { channelId, cumulativeAmount }` for every call.
- `claim(channelId, cumulativeAmount, voucherSig)` seller (or anyone for the seller). Pays `cumulative - alreadyClaimed` to the payee minus the fee. Callable many times.
- `topUp(channelId, amount, intentSig)` agent-signed, `_charge`d.
- `requestClose(channelId)` owner or agent starts a challenge window (default 10 minutes, configurable). The seller can still claim. `finalizeClose` refunds the remainder to the owner balance and credits it back to the session's daily and total spend.
- **Revoke behaviour:** revoking a session blocks new channels and top-ups immediately. It also starts the close window on all of that session's open channels, so sellers can still claim vouchers already signed. Document this as fair to both sides.

**Mode `task` (escrow)**
- `createTask(sessionId, stallId, amount, specHash, deadline, intentSig)` is `_charge`d into escrow.
- `submitResult(taskId, resultHash, resultURI)` stall owner or payee.
- `approve(taskId)` owner, or agent when `session` allows agent approval (a flag). Releases to the payee minus the fee.
- `autoRelease(taskId)` after a review window with no dispute.
- `dispute(taskId)` owner, within the review window. Then `resolve(taskId, buyerBps)` arbiter splits the escrow.
- `cancel(taskId)` buyer refund if the seller never submits by the deadline.

**Receipts**
- Every payout writes `Receipt { sessionId, stallId, amount, mode, timestamp }` keyed by `receiptId`. Reputation reads it.

### 7.4 `ReputationRegistry` [VERIFY, see 7.1]

- `rate(receiptId, uint8 score 1..5, string commentURI)` only by the receipt's owner or session agent, once per receipt.
- Views: `average(stallId)`, `count(stallId)`.

### 7.5 Deploy

- `script/Deploy.s.sol` deploys everything, sets treasury, arbiter, fee and minStake, and writes `deployments/<chainId>.json` with addresses and the deploy block.
- `make deploy-fork`, `make deploy-aevum` (with `--legacy`), `make check-shanghai`.

### 7.6 Contract tests

- Unit tests for each function and each revert path.
- **Fuzz and invariant tests:** total vault tUSD8 == sum of free balances + channel balances + escrow + stakes. A session can never spend more than `totalCap`, never more than `dailyCap` in a day, and never pay a disallowed category. Revoked or expired sessions can never be charged.
- **Signature tests:** replayed nonces, wrong chain ID, expired `validBefore`, quote signed by the wrong key, voucher for another channel.
- **Fork tests** against real tUSD8 on an Aevum fork (permit and 3009 funding).
- Shanghai bytecode check in CI.

## 8. Off-chain components

### 8.1 `packages/x402` [VERIFY header names and payload shapes against the current x402 spec]

- 402 response carries a `PAYMENT-REQUIRED` header (base64 JSON). It lists accepted options: `{ scheme: "exact" | "batch-settlement" | "escrow", network: "eip155:44005", asset: tUSD8, amount or unitPrice, payTo, stallId, quote, quoteSig, facilitator }`.
- The client retries with `PAYMENT-SIGNATURE` (base64 JSON: intent + sig, or voucher + sig).
- The success response carries `PAYMENT-RESPONSE` (receipt ID or voucher acknowledgement, tx hash when settled).
- Export zod schemas, encode/decode helpers and EIP-712 type definitions shared by everyone.

### 8.2 Facilitator (`services/facilitator`) [VERIFY whether QDay runs an official x402 facilitator; if it does and supports this flow, add an adapter and use it for `exact`]

- `GET /supported` lists schemes and network.
- `POST /verify` checks signatures, deadlines, nonces, session state and caps by reading the contract (no tx). Returns ok or a reason code.
- `POST /settle` submits `payExact`, `openChannel`, `topUp`, `createTask` or `depositWithAuthorization`. Pays gas in tQDAY with legacy txs. Returns the tx hash and receipt ID.
- **Rails:** persistent per-IP, per-session and per-day limits in SQLite (not in memory). Refuses anything the chain would reject. Low tQDAY balance alert. Refuses anvil default keys on Aevum.
- `GET /activity` lists recent settlements and refusals (with reason codes) for the dashboard.

### 8.3 Seller SDK (`packages/sdk/seller`)

```ts
const seller = createSeller({ quoteKey, payee, stallId, facilitatorUrl });
app.post("/s/lexmodel", seller.paid({
  mode: "stream", unitPrice: 2000n, unit: "1k tokens",
  maxCost: (req) => 2000n * 4n,            // most this request can cost; quoted up front
  meter:   (req, res) => res.locals.tokens  // actual usage, charged via voucher
}), handler);
```
- No payment: 402 with a fresh signed quote.
- `exact`: verify through the facilitator, settle, then run the handler. Include the receipt in `PAYMENT-RESPONSE`.
- `stream`: verify the voucher locally (sig, channel state cached from chain, cumulative increases by ≤ quoted max). Store it in SQLite. A **settler** loop claims the latest voucher per channel every N seconds or when unclaimed > threshold.
- `task`: accept the task ID, process async, call `submitResult`.
- Serves `/.well-known/agent-card.json`.

### 8.4 Buyer SDK (`packages/sdk/buyer`)

- `payingFetch(url, init, { sessionKey, sessionId, budget })` handles 402 automatically: choose an option, run checks, sign, retry.
- **Client-side guards before signing** (defence in depth; the contract is the real guard):
  - **Confirmation of Payee:** the quote's `payTo` must equal the on-chain `stall.payee` *and* the payee in the seller's agent card. Otherwise refuse with `PAYEE_MISMATCH`.
  - Quote amount ≤ the on-chain `unitPrice × maxUnits` and ≤ the local per-call budget. Otherwise refuse with `OVERPRICED`.
  - Session not revoked or expired (cached chain read, refreshed every few seconds).
- Manages channels: open on the first stream call, sign increasing vouchers, top up when low, close when idle.
- Returns `{ data, receipt, spent }` so the agent can report costs.

### 8.5 Demo stalls (`services/sellers`)

One Express server, many stalls, one seed script that registers identities and stalls on chain with small stakes. LLM-backed stalls use an OpenAI-compatible endpoint from env (Ollama `qwen2.5` locally by default).

| # | Stall | Category | Mode | Price (tUSD8) |
|---|---|---|---|---|
| 1 | LexModel: legal-tuned chat model | inference | stream | 0.002 / 1k tokens |
| 2 | Clause risk dataset (bundled CSV) | data | stream | 0.0005 / row |
| 3 | Case notes search (local corpus + embeddings) | knowledge | exact | 0.001 / query |
| 4 | Risk memo writer skill (downloadable skill file) | skill | license | 0.2 / license |
| 5 | Draft judge (LLM grader with rubric) | eval | exact | 0.001 / call |
| 6 | Batch embeddings job | compute | task | 0.05 / job |
| 7 | Human review board (approved in the web UI) | human | task | 0.1 / task |
| 8 | **Shady stall** (demo only): quotes 10× its on-chain price and uses a payee that doesn't match its agent card | tool | exact | — |

Stall 8 exists so the demo can show the agent refusing to pay. Flag it clearly as a demo fixture.

#### 8.5.1 Optional stalls (P1: build after M4 if time allows, otherwise leave for later)

| # | Stall | Category | Mode | Price (tUSD8) | Notes |
|---|---|---|---|---|---|
| 9 | **Research Agent** (agent-for-hire) | outcome | task | 0.15 / job | Takes a research brief and delivers a cited report. **It buys from other stalls itself** (case search, dataset, LexModel) through its own AgentVault account and session, funded from its own earnings, with its own caps. Shows agents hiring agents, each with its own on-chain budget. The `/activity` feed should group its sub-purchases under the parent task ID. |
| 10 | **Paid MCP server** (e.g. "Contract Tools MCP": clause extractor, date/party parser) | tool | exact | 0.001 / tool call | A remote MCP server (Streamable HTTP) whose tool calls are paid per call via x402. The buyer MCP server proxies to it. Shows any MCP server can be sold on the market. |

Agent-to-agent rules for stall 9 (and any future agent stall):
- The seller agent pays for its sub-purchases from **its own** vault account, never from the buyer's. The buyer only pays the agent's quoted task price.
- The agent's session caps must be lower than the task price, so it can't lose money on one job by mistake.
- The task result includes a cost breakdown (sub-receipt IDs) so the buyer can see what was bought.

### 8.5.2 Future catalog (backlog; not part of this hackathon build)

Ideas that fit the existing payment modes without contract changes. Each needs only a seller stall and a category value. Add new category values to the enum and `metadataURI` tags; keep the contract's `uint8 category` with room to grow (bit mask is `uint32`).

| Product | Mode | Unit |
|---|---|---|
| Rent-an-agent by step (support agent, tutor, negotiator) | stream | per message / per minute |
| Prompts, workflows, agent configs ("agent recipes") | license | one-time |
| Hosted agent memory / vector store | stream | per read or write, or per MB per day |
| Browser sessions / code sandboxes | stream | per minute |
| GPU time (fine-tuning, rendering) | task | per job or per GPU-minute |
| Fact-checking and verification (claims, sources, contract-address safety) | exact | per check |
| Data feeds (prices, weather, on-chain analytics) | stream | per query or per update |
| Translation, transcription, OCR | exact / stream | per page, per minute of audio |
| Human work (labeling, expert sign-off, phone calls) | task | per task |
| Reputation checks on sellers or agents | exact | per lookup |
| Model weights / LoRA adapters (category already exists) | license | one-time |

Do not list: resold third-party API keys or accounts (breaks their terms), or regulated services such as KYC on real people.

### 8.6 MCP server (`mcp/`)

Runs over stdio for Claude Code and Codex. Holds **only the session key** and reads `SESSION_ID` from env. Tools:

| Tool | Does |
|---|---|
| `market_search` | Find stalls by text, category or max price, with ratings |
| `wallet_status` | Session caps, spent today and in total, remaining, expiry, revoked? |
| `call_service` | Call an `exact` or `stream` stall; returns the result plus cost |
| `buy_license` / `download_skill` | Buy a license, then fetch the skill file |
| `create_task` / `get_task` / `approve_task` | Escrow flows |
| `rate_service` | Leave a rating with a receipt |

Every tool result includes `spent` and `remaining` so the agent can reason about its budget. Refusals return a readable reason (`CAP_EXCEEDED`, `SESSION_REVOKED`, `PAYEE_MISMATCH`, `OVERPRICED`, `CATEGORY_NOT_ALLOWED`). Include a `mcp/README.md` with config snippets for Claude Code and Codex.

### 8.7 Web app (`web/`)

Wallet connect with Aevum as a custom chain and an "Add Aevum to wallet" button. Reads through polling plus chunked logs from the deploy block, with an in-memory or SQLite indexer in a Next.js route.

| Page | Contents |
|---|---|
| `/` | Hero, how it works, live stats (stalls, payments, tUSD8 settled), latest receipts ticker |
| `/market` | Stall grid with filter by category, mode and price; rating; CoP badge |
| `/stall/[id]` | Details, price, example request, receipts, ratings, identity, stake |
| `/wallet` | **Owner console:** deposit (gasless via 3009 + facilitator, or approve), create session (caps, expiry, categories, allowlist), show the session key setup command for MCP, live spend vs caps bars, **big Revoke button**, open channels, withdraw |
| `/sell` | Register identity, create stall with stake. Before listing, checks the endpoint returns a valid 402 and the agent card payee matches |
| `/tasks` | Task board; the human review stall's queue where a person approves or rejects |
| `/activity` | Live feed of payments, claims, refusals (from the facilitator), revokes, with explorer links |

Design: clean and legible, one accent color, works in light and dark, mobile OK. Show tUSD8 amounts with 4 decimals.

## 9. Core workflows (each needs an end-to-end test on the fork and one recorded run on Aevum)

1. **Owner setup:** connect → deposit 3 tUSD8 (gasless) → create session (per-payment 0.2, daily 1.0, total 2.0, expiry 2h, categories: all but `tool`) → copy the session config into MCP.
2. **Exact pay:** agent calls case search → 402 → CoP + price checks → intent signed → facilitator settles → result returned with receipt.
3. **Streaming:** agent chats with LexModel → channel opened (0.05) → vouchers per response → seller settler claims in batches → idle close and refund.
4. **License:** agent buys the risk memo skill → downloads → installs it locally.
5. **Task:** agent hires the human reviewer → a person approves in `/tasks` → result returned → funds released.
6. **Refusals:** Shady stall → `PAYEE_MISMATCH`/`OVERPRICED`, nothing signed. Payment above cap → contract rejects, facilitator reports `CAP_EXCEEDED`.
7. **Kill switch:** owner clicks Revoke mid-run → the next agent call fails with `SESSION_REVOKED` within seconds → open channels enter the close window → remainder refunded.
8. **Seller onboarding:** new seller lists a stall from `/sell` with the 402 check passing.

## 10. Non-functional requirements

- **Safety first:** every limit enforced on chain; client guards are extra. No admin can move user balances (the arbiter only splits disputed escrow and slashes stake).
- **Gasless for agents:** agents never need tQDAY.
- **Performance:** a paid `exact` call completes in < 5 s on Aevum; stream calls add no on-chain latency per call.
- **Reliability:** facilitator and settler survive restarts (SQLite). Idempotent settle (same intent twice = one payment).
- **Observability:** structured logs; `/activity` shows refusals with reasons.
- **Deployability:** `docker compose up` runs facilitator, sellers and web against Aevum with only `.env` filled in. The web app also deploys to Vercel.

## 11. Judging criteria mapping (100 points)

| Criterion | Points | How this project scores |
|---|---|---|
| Innovation and originality | 20 | Full agent marketplace with four payment modes behind one session wallet; MCP agent shops on its own; CoP for agent payments |
| UX and presentation | 15 | Owner console with live spend bars and Revoke; one-prompt agent demo; clean market UI |
| Technical quality and platform integration | 15 | tUSD8 permit + EIP-3009, x402 flows, Shanghai-safe bytecode, legacy txs, chunked logs, fork tests against real tUSD8, official QDay infra where published |
| Real-world utility | 15 | Sellers earn per request from agents; owners give agents budgets, not wallets |
| Safety, trust and controls | 15 | On-chain caps, expiry, categories, allowlist, revoke, seller-signed quotes, CoP, escrow with disputes, stake + slashing, invariant tests |
| Demo | 10 | Scripted 3 to 5 minute run (section 13) |
| Documentation | 10 | README with problem, architecture, workflows, tech, addresses, commit link; `docs/` folder |

## 12. Milestones (today is Nov 24)

| # | Dates (IST) | Deliverable | Done when |
|---|---|---|---|
| M0 | Nov 25 | Scaffold: pnpm workspace, Foundry (Shanghai, OZ 5.1.0), `packages/aevum`, fork + anvil Makefile targets, Shanghai check, CI (forge test + vitest + typecheck) | `make test` green; wallet funded from faucet; `check-setup` script prints Aevum balances |
| M1 | Nov 25–28 | All contracts + tests (unit, fuzz, invariant, fork) + deploy script; deployed to Aevum | ≥90% coverage; addresses in `deployments/44005.json` |
| M2 | Nov 28–Dec 2 | `packages/x402`, facilitator, buyer + seller SDK, demo stalls + seed | Workflows 2–6 pass end to end on the fork |
| M3 | Dec 2–5 | MCP server + web app (all pages) | Workflows 1–8 pass on the fork; Claude Code completes the demo prompt |
| M4 | Dec 5–8 | Live on Aevum: deploy facilitator + sellers (Docker / VPS) and web (Vercel); full run on Aevum; fix testnet-only bugs | All workflows recorded on Aevum with explorer links |
| M5 | Dec 8–10 | README, `docs/`, demo video, DoraHacks BUIDL page; dry-run Demo Day script | Submission checklist complete; feature freeze Dec 10 12:00 IST |
| — | Dec 11 before 13:30 IST | Submit on DoraHacks | Submitted |
| — | Dec 15 11:30 IST | Live Demo Day (if top 5) | Rehearsed twice |

**Optional after M4:** stalls 9 (Research Agent) and 10 (Paid MCP server) from 8.5.1. If built, add a 20-second beat to the demo after step 3: the agent hires the Research Agent, and `/activity` shows it buying from other stalls with its own budget.

**Cut order if time runs short** (cut from the top): reputation ratings → compute job stall → `/sell` 402 checker (use the seed script instead) → license mode → stream top-up. **Never cut:** AgentVault caps + revoke, `exact` + `stream`, CoP check, MCP demo, Shady stall refusal.

## 13. Demo script (3 to 5 minutes, also the video)

1. (30 s) Problem: agents can't pay, and giving them a wallet is dangerous.
2. (45 s) Owner console: deposit 3 tUSD8 without gas, create a session (caps, 2h expiry), paste the session config into Claude Code.
3. (90 s) One prompt in Claude Code: "Review this NDA and write a risk memo. Budget 1 tUSD8." Show stalls being paid live in `/activity`: dataset rows streaming, case search, LexModel per token, skill license bought and installed, draft judged, human review requested and approved.
4. (30 s) The agent finds the Shady stall and refuses it: payee mismatch.
5. (30 s) Ask for something over the cap: the contract rejects it.
6. (30 s) Hit **Revoke**. The next call fails within seconds. Unused channel funds come back.
7. (15 s) Close: sellers earn per request from agents; owners give agents budgets, not wallets. Fee model 3%.

## 14. Submission checklist

- [ ] Public GitHub repo, MIT `LICENSE`, `NOTICE.md` (starter kit attribution if used, all deps)
- [ ] README: problem, solution, architecture diagram, core workflows, tech stack, how to run (fork and Aevum), contract addresses + source commit link, demo video link, live URL
- [ ] Evidence of Aevum use: addresses, explorer links to real tUSD8 payments, deploy block
- [ ] Live deployment: web URL + facilitator/sellers running, or Docker image
- [ ] Demo video (3 to 5 minutes)
- [ ] DoraHacks BUIDL submitted to the Aevum Builder Challenge #1, track Native AI Assistants
- [ ] One team member available live on Dec 15, 11:30 IST

## 15. Open questions (answers go in `docs/QDAY_NOTES.md`)

1. Is there a public QDay x402 facilitator endpoint for Aevum, and which schemes and tokens does it support?
2. Official addresses for the stablecoin paymaster, agent wallet / session key contracts, and ERC-8004 registries? If agent wallets exist, can AgentVault sit on top of them?
3. Is `bundler.qday.info` the supported ERC-4337 bundler? (Not needed for MVP; the facilitator relays instead.)
4. Exact submission form fields on DoraHacks.

## 16. Out of scope

Mainnet, real money, a project token, ERC-4337 smart accounts (stretch only), post-quantum signatures (mention in the roadmap: QDay's hybrid ECDSA + ML-DSA migration), decentralised arbitration, cross-chain.
