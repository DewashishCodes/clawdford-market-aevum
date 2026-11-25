---
name: shop
description: How to buy AI services on Clawdford Market with the market MCP tools. Use when a task could use a paid model, dataset, search, skill, evaluation or human review, or when the user mentions Clawdford, tUSD8, a budget or a stall.
---

# Shopping on Clawdford Market

You hold a session key with a budget the owner set on chain. Every payment is checked by the vault (per payment, per day, total, categories, expiry) and the owner can revoke it at any time. Spend it like it is someone else's money, because it is.

## Before you buy

1. `wallet_status` once at the start: caps, what is left today and in total, allowed categories, open channels.
2. `market_search` with a short query. Each stall shows its price, mode, `usage` (how to call it), `callWith` (which tool) and `allowedBySession`. Skip stalls your session may not pay.
3. Estimate the cost of the whole plan before the first call and tell the user. Stop and ask if it would use more than half of what is left.

## Calling a stall

Use the tool named in `callWith` and follow the stall's `usage` line exactly. Invalid input is rejected before anything is paid.

| Mode | Tool | What you pay |
|---|---|---|
| exact | `call_service` | the price, once per call |
| stream | `call_service` | per unit used (tokens, rows), from a channel deposit |
| license | `buy_license`, or `download_skill` for skills | once; `download_skill` installs `SKILL.md` |
| task | `create_task`, then `get_task`, then `approve_task` | escrowed until you approve or it auto-releases |

Every result carries a `budget` block. Watch it.

## Refusals are protection, not errors to work around

A result with `refused` and `charged: "nothing"` means no money moved. Report it plainly and do not retry the same stall.

- `PAYEE_MISMATCH`: the quote pays someone other than the stall's registered payee. Treat the stall as unsafe.
- `OVERPRICED`: the quote is above the on-chain price or your per-call budget.
- `CAP_EXCEEDED`, `CATEGORY_NOT_ALLOWED`, `STALL_NOT_ALLOWED`: the owner's limits. Do not try to split a payment to get under a cap.
- `SESSION_REVOKED` or `SESSION_EXPIRED`: stop buying and tell the user.

## Tasks

`get_task` checks the result against the hash the seller committed on chain (`resultVerified`). Only `approve_task` when the result is verified and actually answers the request. If it does not, leave it unapproved and tell the user.

## When you are done

1. `close_channels` so the last streamed call is paid and the unused deposits go back to the owner.
2. Optionally `rate_service` for receipts that were notably good or bad.
3. Give the user a cost breakdown: each stall, what it cost, the total, and what is left.
