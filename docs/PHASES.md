# Development Phases

This plan splits the PRD (`docs/PRD.md`, section 12) into small phases. Each phase:

- lives on its own branch `phase/<n>-<slug>`,
- lands through a pull request into `main` (merge commit, so the phase stays visible in history),
- ends with green tests and a status note in `docs/PROGRESS.md`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `test`, `docs`, `chore`, `ci`, `refactor`, with a scope where it helps (`feat(vault): ...`). One logical step per commit.

| Phase | PRD milestone | Branch | Dates (IST) | Deliverable | Done when | Status |
|---|---|---|---|---|---|---|
| 0 | M0 | `phase/0-scaffold` | Nov 24 to 25 | pnpm workspace, Foundry (Shanghai, OZ 5.1.0), `packages/aevum`, Makefile (anvil, fork), Shanghai bytecode check, `check-setup`, CI | `make test` green, CI green | done (PR #1) |
| 1 | M1 | `phase/1-registries` | Nov 25 to 26 | `MockTUSD8`, `IdentityRegistry`, `StallRegistry` (stake, cooldown, slash) + tests | unit tests green | done (PR #2) |
| 2 | M1 | `phase/2-vault-core` | Nov 26 | `AgentVault` balances (approve, permit, 3009), sessions, `_charge`, receipts, `payExact` + license | unit + signature tests green | done (PR #3) |
| 3 | M1 | `phase/3-vault-modes` | Nov 27 | stream channels (open, claim, topUp, close, revoke behaviour) and task escrow (submit, approve, autoRelease, dispute, resolve, cancel) | unit tests green | done (PR #4) |
| 4 | M1 | `phase/4-reputation-deploy` | Nov 28 | `ReputationRegistry`, fuzz + invariant tests, fork tests on real tUSD8, `Deploy.s.sol`, deploy to Aevum | coverage at least 90%, `deployments/44005.json` | done (PR #5, deploy PR #6) |
| 5 | M2 | `phase/5-x402-facilitator` | Nov 28 to 30 | `packages/x402` (schemas, headers, EIP-712), facilitator (`/supported`, `/verify`, `/settle`, `/activity`, SQLite rails) | vitest green, exact pay works on fork | done (PR #7) |
| 6 | M2 | `phase/6-sdk` | Nov 30 to Dec 1 | buyer SDK (`payingFetch`, CoP, price guard, channels) and seller SDK (`paid()`, voucher store, settler, agent card) | vitest green | done (PR #8) |
| 7 | M2 | `phase/7-stalls` | Dec 1 to 2 | demo stalls 1 to 8 + seed script | workflows 2 to 6 pass end to end on fork | done (PR #10) |
| 8 | M3 | `phase/8-mcp` | Dec 2 to 3 | MCP server with all tools + `mcp/README.md` | Claude Code completes the demo prompt on fork | done (PR #11) |
| 9 | M3 | `phase/9-web` | Dec 3 to 5 | Next.js app: `/`, `/market`, `/stall/[id]`, `/wallet`, `/sell`, `/tasks`, `/activity` | workflows 1 to 8 pass on fork | done (PR #12) |
| 10 | M4 | `phase/10-live` | Dec 5 to 8 | Docker compose, VPS for facilitator + sellers, Vercel for web, full run on Aevum, testnet fixes | every workflow recorded with explorer links | todo |
| 11 | M5 | `phase/11-submission` | Dec 8 to 10 | README, `docs/`, demo video, DoraHacks page, Demo Day rehearsal | checklist done, freeze Dec 10 12:00 IST | todo |
| opt | after M4 | `phase/opt-agent-stalls` | if time allows | stall 9 (Research Agent), stall 10 (paid MCP server) | demo beat recorded | todo |

Submission: Dec 11 before 13:30 IST. Demo Day: Dec 15, 11:30 IST.

## Cut order

If time runs short, cut from the top: reputation ratings, compute job stall, `/sell` 402 checker, license mode, stream top up.

Never cut: AgentVault caps and revoke, `exact` and `stream`, Confirmation of Payee check, MCP demo, Shady stall refusal.

## Rules that apply to every phase

- No private keys or `.env` files in git. Only `.env.example` with placeholders.
- Contracts compile for `shanghai`; CI scans bytecode for Cancun opcodes.
- Chain writes use legacy transactions; log reads go through `getLogsChunked`.
- Anything marked [VERIFY] in the PRD gets checked and written into `docs/QDAY_NOTES.md`.
- PRD vs reality conflicts go into `docs/DECISIONS.md`.
