# Progress

Newest first. One entry per phase (see `docs/PHASES.md`).

## Phase 0: scaffold (Nov 24)

- pnpm workspace, shared `tsconfig.base.json`.
- Foundry project in `contracts/`: solc 0.8.24, `evm_version = "shanghai"`, OpenZeppelin pinned to v5.1.0, forge-std v1.9.4.
- `tools/check-shanghai.mjs`: fails the build if runtime bytecode uses BLOBHASH, BLOBBASEFEE, TLOAD, TSTORE or MCOPY. Self-tested.
- `packages/aevum`: viem chain definitions (Aevum 44005, fork 440050, anvil 31337), tUSD8 constants, `getLogsChunked` (1,000-block chunks, tested).
- `pnpm check-setup` prints chain id, head block and balances for each role key in `.env`. Verified live against `rpc-test.qday.info` (chain id 44005).
- Makefile targets: `test`, `anvil`, `fork`, `deploy-fork`, `deploy-aevum`, `check-shanghai`, `coverage`. Root pnpm scripts cover the same on machines without make.
- CI: forge build + test, Shanghai check, typecheck, vitest.

Open: wallets funded from faucet (needs the user: web faucet + Discord `/faucet`).
