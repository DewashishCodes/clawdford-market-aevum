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
| Nov 24 | Protocol deployed with legacy txs at block 4,018,135 from commit `09a27a4`: AgentVault `0x88f4...5BBE`, StallRegistry `0xfBF1...AD70`, IdentityRegistry `0x3580...8bf8`, ReputationRegistry `0xE93A...afC3`. Gas price 1 gwei, about 11.6M gas total. Treasury and arbiter are the deployer for now | `deployments/44005.json`, `cast code` |

## Open questions (PRD section 15)

1. Public QDay x402 facilitator for Aevum? Schemes and tokens? (pending)
2. Official addresses for stablecoin paymaster, agent wallet / session key contracts, ERC-8004 registries? (pending)
3. Is `bundler.qday.info` the supported ERC-4337 bundler? (pending, not needed for MVP)
4. Exact DoraHacks submission form fields? (pending)
