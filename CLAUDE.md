# Working on Clawdford Market

Read first: `docs/PROGRESS.md` (top section "Next session: start here"), then `docs/PHASES.md`. `docs/PRD.md` is the source of truth for scope.

## Workflow

- One branch per phase: `phase/<n>-<slug>` off `main`. Land it with a PR (merge commit, not squash) once CI is green, then delete the branch.
- Many small Conventional Commits (`feat(vault): ...`, `test(...)`, `docs: ...`), one logical step each. Use the local alias `git c` (adds the Claude Co-Authored-By trailer; set it up with `git config alias.c 'commit --trailer "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"'` if missing).
- End each phase with a `docs/PROGRESS.md` entry. Log PRD-vs-reality choices in `docs/DECISIONS.md`, verified chain facts in `docs/QDAY_NOTES.md`.
- No em or en dashes in any docs, comments or messages.
- Write all code fresh. Do not copy from other repos (including the older Monad version of this project). Only the Aevum Starter Kit may be reused, with attribution in `NOTICE.md`.
- Never commit `.env` or private keys.

## Commands

- Contracts: `cd contracts && forge test`, `forge fmt` (CI runs `forge fmt --check`), `forge build --sizes` (AgentVault is ~22.2 KB of the 24,576 limit).
- Coverage: `forge coverage --no-match-coverage "(test|script)/" --report summary`.
- Fork tests: `AEVUM_FORK=true forge test --match-path "test/fork/*"`.
- E2E (spawn anvil, deploy, pay over HTTP): `FACILITATOR_E2E=anvil` in `services/facilitator`, `SDK_E2E=anvil` in `packages/sdk`, `SELLERS_E2E=anvil` in `services/sellers`, `MCP_E2E=anvil` in `mcp`, `WEB_E2E=anvil` in `web`, each `pnpm exec vitest run test/e2e.test.ts`. Use `fork` for the Aevum fork. Run them one at a time (all write `deployments/31337.json`). Shared setup is `packages/testkit`.
- After contract changes: `forge build` then `pnpm export-abis` (regenerates `packages/aevum/src/abis.ts`).
- TypeScript: `pnpm typecheck`, `pnpm test`. Shanghai scan: `pnpm check-shanghai`.
- Local demo stack on a fork: `pnpm --filter @clawdford/mcp dev-stack` (writes `mcp/dev-mcp.json` for `claude --mcp-config` and prints the env line that starts the web app with a dev wallet). `pnpm --filter @clawdford/mcp call-tool <tool> '<json>'` runs one MCP tool as that agent.
- No `make` on the Windows dev box; root `package.json` scripts mirror the Makefile.

## Gotchas

- Aevum is Shanghai: keep OpenZeppelin at v5.1.0, no transient storage, legacy txs, `getLogsChunked` for logs.
- In tests, `vm.expectRevert` applies to the next external call. Build signatures (which call `vault.hashQuote` etc.) before `expectRevert`; see `_payReverts` in `test/utils/VaultFixture.sol`.
- Vault structs, errors and events live on `VaultBase` / `VaultChannels` / `VaultTasks`; reference them through those names, not `AgentVault.X`.
- Bash heredocs in this environment drop backslashes; write code files with an editor tool.
- Workspace packages export TypeScript source (`exports: ./src/index.ts`); run services with `tsx`.
- The GitHub default branch is `main` (PRs target `main`).
- `pnpm add` fails from the lowercase cwd path (`desktop/projects`). Run `pnpm --filter <pkg> add ...` from `C:/Users/Dewashish Lambore/Desktop/PROJECTS/aevum_hackathon`.
- `node:sqlite` is loaded with `createRequire` because vitest 2 can't resolve it as an import (see `shortcut:` comments).
- The x402 envelope is v2 but our payloads are vault messages (D11); streams are pay as you go (D12); the facilitator pays sellers' gas (D13); agent cards come from the identity's on-chain URI (D14).
