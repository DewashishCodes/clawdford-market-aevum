# Decisions

Where the PRD and reality disagree, or where the PRD leaves a choice open. Newest last.

## D1. Shanghai checker written fresh (Nov 24)

The PRD allows reusing the starter kit's `tools/check-shanghai.mjs` with attribution. We wrote our own instead, so no third-party code is in the repo yet. It walks runtime bytecode, skips PUSH immediates and strips the solc metadata tail before matching opcodes.

## D2. Fork chain id 440050 (Nov 24)

The local fork runs with `--chain-id 440050`, so EIP-712 signatures made on the fork can never be replayed on Aevum (44005).

## D3. Workspace packages export TypeScript source (Nov 24)

Workspace packages point `exports` at `src/*.ts`. Services run through `tsx` and the Next.js app uses `transpilePackages`, so there is no per-package build step to forget.
