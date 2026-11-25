# QDay / Aevum notes

Facts checked against live sources. Answers to PRD section 15 go here.

## Verified

| Date | Fact | Source |
|---|---|---|
| Nov 24 | `https://rpc-test.qday.info` answers `eth_chainId` = 44005; head block around 4,015,341 | `pnpm check-setup` |
| Nov 24 | tUSD8 `0x4565...3483`: name and symbol `tUSD8`, `version()` = "2", 6 decimals, total supply about 3.23M | `cast call` |
| Nov 24 | tUSD8 `DOMAIN_SEPARATOR` = `0x7838e6c4...8022`, equal to EIP712Domain("tUSD8", "2", 44005, token) | `cast call` + local hash |
| Nov 24 | tUSD8 `PERMIT_TYPEHASH`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` match the standard EIP-2612 / EIP-3009 strings (same as `MockTUSD8`) | `cast call` + `cast keccak` |
| Nov 24 | Permit deposit, gasless `receiveWithAuthorization` deposit and a full `payExact` all work against the real token on a fork | `test/fork/AevumFork.t.sol` |
| Nov 25 | Every PRD workflow ran on Aevum with real tUSD8: gasless EIP-3009 deposit relayed, exact, stream (open, vouchers, claims, close, finalize with refund), license, task escrow with gasless approve, rating, revoke. Claims during the close window after a revoke are accepted. Rating costs about 0.0001 tQDAY at 1 gwei | `docs/demo-runs/2026-11-25-aevum.md` |
| Nov 24 | Protocol deployed with legacy txs at block 4,018,135 from commit `09a27a4`: AgentVault `0x88f4...5BBE`, StallRegistry `0xfBF1...AD70`, IdentityRegistry `0x3580...8bf8`, ReputationRegistry `0xE93A...afC3`. Gas price 1 gwei, about 11.6M gas total. Treasury and arbiter are the deployer for now | `deployments/44005.json`, `cast code` |

## Open questions (PRD section 15)

1. Public QDay x402 facilitator for Aevum? Schemes and tokens? (pending)
2. Official addresses for stablecoin paymaster, agent wallet / session key contracts, ERC-8004 registries? (pending)
3. Is `bundler.qday.info` the supported ERC-4337 bundler? (pending, not needed for MVP)
4. Exact DoraHacks submission form fields? Answered Nov 25 from the "Create a new Build" page: logo, name, one-line description, tags, team info, a Markdown description (problem, how it works, key features, tech stack, hackathon requirements), project URL (optional), links (GitHub repo, video, website, X, LinkedIn, other) and contact info (organizers only). **Required: a GitHub, GitLab or Bitbucket link and a demo video** (YouTube, Vimeo, Loom or a direct .mp4). A live URL is optional.

## x402 spec (checked Nov 24, PRD 8.1 [VERIFY])

Sources: `specs/x402-specification-v2.md`, `specs/transports-v2/http.md` and `specs/schemes/exact/scheme_exact_evm.md` in github.com/coinbase/x402 (the repo now points to github.com/x402-foundation/x402), plus docs.cdp.coinbase.com/x402. Newest version found: v2 (dated 2025-12-09).

| Item | v2 (what we use) | v1 (old) |
|---|---|---|
| `x402Version` | `2` | `1` |
| 402 requirements | header `PAYMENT-REQUIRED`, base64 JSON `PaymentRequired` | JSON body |
| client payment | header `PAYMENT-SIGNATURE`, base64 JSON `PaymentPayload` | `X-PAYMENT` |
| settlement result | header `PAYMENT-RESPONSE`, base64 JSON `SettlementResponse` | `X-PAYMENT-RESPONSE` |
| network id | CAIP-2, e.g. `eip155:8453`; ours is `eip155:44005` | names like `base-sepolia` |

Shapes (v2):

- `PaymentRequired`: `x402Version`, `error?`, `resource` (`url`, `description?`, `mimeType?`, ...), `accepts[]`, `extensions?`.
- `PaymentRequirements`: `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds`, `extra`.
- `PaymentPayload`: `x402Version`, `resource?`, `accepted` (the chosen requirements, echoed back), `payload` (scheme specific), `extensions?`.
- `SettlementResponse`: `success`, `errorReason?`, `payer?`, `transaction` (empty string if nothing was sent), `network`, `amount?`.
- Facilitator: `POST /verify` and `POST /settle` take `{ x402Version, paymentPayload, paymentRequirements }`. Verify answers `{ isValid, invalidReason?, payer? }`; settle answers a `SettlementResponse`. `GET /supported` answers `{ kinds: [{ x402Version, scheme, network, extra? }], extensions, signers }`.
- Schemes named in v2: `exact`, `upto`, `batch-settlement`, `auth-capture`; flows `authorization`, `upfront`, `escrow` via `extra.paymentFlow`. The stock EVM `exact` payload is an EIP-3009 `transferWithAuthorization` (`payload.signature` + `payload.authorization`).
- Not confirmed: whether base64 is standard or URL safe (we use standard and accept both), the CDP facilitator's REST details. How we differ from stock x402 is in D11 in `docs/DECISIONS.md`.

