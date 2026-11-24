# Decisions

Where the PRD and reality disagree, or where the PRD leaves a choice open. Newest last.

## D1. Shanghai checker written fresh (Nov 24)

The PRD allows reusing the starter kit's `tools/check-shanghai.mjs` with attribution. We wrote our own instead, so no third-party code is in the repo yet. It walks runtime bytecode, skips PUSH immediates and strips the solc metadata tail before matching opcodes.

## D2. Fork chain id 440050 (Nov 24)

The local fork runs with `--chain-id 440050`, so EIP-712 signatures made on the fork can never be replayed on Aevum (44005).

## D3. Workspace packages export TypeScript source (Nov 24)

Workspace packages point `exports` at `src/*.ts`. Services run through `tsx` and the Next.js app uses `transpilePackages`, so there is no per-package build step to forget.

## D4. Daily cap is a UTC calendar day (Nov 24)

The PRD lets us pick rolling 24h or calendar day. `AgentVault` uses the UTC calendar day (`block.timestamp / 1 days`). It needs two storage fields instead of a ring buffer, it is easy to explain in the owner console ("resets at 05:30 IST"), and `remaining()` rolls the day the same way `_charge` does.

## D5. updateCaps is a re-grant, revoke is final (Nov 24)

Only the session owner can call `updateCaps`, so a "tighten only" rule would protect nothing: the owner could always revoke and create a looser session. `updateCaps` therefore sets any caps and expiry on a live session. A revoked session can never be changed or revived; the owner creates a new one.

## D6. Quote and intent signing (Nov 24)

- Both use the vault's EIP-712 domain (`ClawdfordVault`, version `1`, chain id, vault address), so a signature never replays across chains or deployments.
- `PaymentIntent.quoteHash` is the full EIP-712 digest of the quote (`vault.hashQuote(q)`), the same value the seller signs. Clients compute it with viem `hashTypedData`.
- `Quote.buyerSession = 0` means any session may pay the quote. Sellers that know the session from the request can pin it.
- Each quote can be paid once (`quoteUsed`), and each intent nonce once per session (`intentNonceUsed`). A second settle of the same intent reverts, and the facilitator maps that to the earlier receipt for idempotency.
