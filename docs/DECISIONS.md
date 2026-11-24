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

## D7. Vault split into modules, one deployed contract (Nov 24)

The PRD keeps channels and escrow inside `AgentVault`. We keep that (one address, one balance sheet, one `_charge`) but split the source into `vault/VaultBase.sol` (balances, sessions, `_charge`, exact + license), `vault/VaultChannels.sol` (stream) and `vault/VaultTasks.sol` (task). `AgentVault` inherits both modes. Runtime size is 22,176 bytes, under the EIP-170 limit of 24,576; CI's `forge build --sizes` fails if it ever grows past it. If it does, the first lever is a lower `optimizer_runs`.

## D8. Payee fixed when a channel or task is opened (Nov 24)

Channels and tasks copy the stall's payee at creation. A seller who later changes the stall payee cannot redirect money the buyer already committed. This keeps Confirmation of Payee true for the whole life of the channel or task.

## D9. Refunds never reopen today's cap (Nov 24)

When a channel closes or a task is refunded, the full amount goes back to the owner and to `spentTotal`. `spentToday` is only credited for what that same channel or task was charged today. A deposit made yesterday and refunded today does not create extra room under today's daily cap.

## D10. Agents act gaslessly by signature (Nov 24)

Every agent action has a signed form a relayer can submit: `PaymentIntent`, `OpenChannel`, `TopUp`, `Voucher`, `CloseChannel`, `CreateTask`, `ApproveTask`. All share one nonce space per session. Owner actions (`revokeSession`, `dispute`, `withdraw`) are normal transactions from the owner wallet, so the kill switch never depends on the facilitator.

## D11. x402 v2 envelope, vault payloads inside (Nov 24)

We follow x402 v2 for everything a generic client sees: the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers, `x402Version: 2`, CAIP-2 network `eip155:44005`, the `PaymentRequired` / `PaymentPayload` / `SettlementResponse` field names and the facilitator `/verify`, `/settle`, `/supported` bodies.

The payload inside differs from stock x402. Stock EVM `exact` moves tokens with EIP-3009 straight from the payer's wallet. Ours spends from `AgentVault` under session caps, so:

- `exact`: `accepted.extra` carries the seller-signed `Quote` and `stallId`; the payload is the agent-signed `PaymentIntent`.
- `batch-settlement` (stream): the payload is an agent-signed `OpenChannel` or `TopUp`; per-call `Voucher`s go to the seller, who claims them in batches.
- `escrow` (task): the payload is an agent-signed `CreateTask`. The PRD calls this scheme `escrow`; v2 treats escrow as a flow, but a separate scheme name keeps our payload from being mistaken for stock `auth-capture`.

Stock x402 clients therefore can't pay our stalls without the buyer SDK, and our clients can't pay stock x402 sellers. That's fine for the hackathon: the session caps are the point of the product. `amount` in requirements is a decimal string in tUSD8 base units (6 decimals), as in the spec.

The facilitator's `/verify` runs the real vault call as an `eth_call`, so the contract decides validity (signatures, deadlines, nonces, revoke, caps). The custom error name becomes `invalidReason`.

