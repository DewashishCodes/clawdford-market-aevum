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

## D12. Stream calls are pay as you go (Nov 24)

`claim` pays exactly the amount a voucher signs, so the seller can't settle less than a signed voucher. Signing the full possible cost up front would let the seller collect unused headroom. So each request carries a voucher for everything served before it. The seller checks the voucher covers what it is owed and that the channel has room for this request's maximum (`extra.maxAmount`). It meters the real cost and returns the new total as `owed` in `PAYMENT-RESPONSE`. The buyer refuses (`OVERCHARGED`) if one call grew `owed` by more than its quoted maximum. The seller's risk is at most the last request, and the buyer pays even that when it closes the channel (a final voucher goes to the facilitator's `/claim`).

## D13. The facilitator pays sellers' gas, with a minimum claim (Nov 24)

Like card processors and the hosted x402 facilitators, the platform pays settlement gas and the 3% fee covers it; batching keeps gas a tiny share of the fee. The facilitator relays `claim`, `requestCloseWithSig` and `finalizeClose` (`/claim`, `/close`), through the same daily limits and send queue as payments. To stop tiny claims costing more gas than they earn, an open channel's claim must be at least `MIN_CLAIM` (default 0.01 tUSD8). Closing channels are exempt, so a seller is never stranded. The contract still lets anyone call `claim`, so if the facilitator is down a seller can claim with its own gas.

## D14. Agent card comes from the identity's on-chain URI (Nov 24)

The PRD puts the card at `/.well-known/agent-card.json`, but one server hosts many stalls (PRD 8.5), so that path can't be per stall. The buyer instead reads `IdentityRegistry.getIdentity(stall.identityId).agentCardURI` (the ERC-8004 way) and fetches it. The card lists its `stallIds` and `payee`. Confirmation of Payee passes only if the quote's `payTo`, the stall's registered payee and the card's payee all match and the card lists the stall.


## D15. Demo stalls: one seller key, two identities, any OpenAI-compatible LLM (Nov 25)

All eight stalls share one seller key (owner, payee and quote signer) and run on one server. Stalls 1 to 7 hang off one identity whose agent card lists them; the Shady stall has its own identity so its card can name a different payee. The buyer checks the payee before the price, so the Shady stall is refused with `PAYEE_MISMATCH`; its 10x quote would hit `OVERPRICED` if the payee matched. LLM stalls (LexModel, draft judge) take any OpenAI-compatible endpoint from env (PRD default Ollama `qwen2.5`; Groq or Gemini work for the demo) and present it under the stall's own model name. Simplifications, each marked `shortcut:` in code: case search ranks by keyword overlap, the embeddings job uses hashed bag-of-words vectors, task results and the review queue live in memory, and every skill download is a new license purchase. Inputs are validated before the 402, so a buyer never pays for a request the stall would reject.

## D16. Ratings are sent by the agent key itself, which then needs gas (Nov 25)

`ReputationRegistry.rate` checks `msg.sender` is the session owner or agent and has no signature variant, and the MCP agent holds no gas. Adding `rateWithSig` means redeploying the registry on Aevum; ratings are first in the PRD cut order, so we kept the contract. `rate_service` sends the rating from the agent key when it holds a little tQDAY and otherwise explains that the owner can rate from the web app. Revisit with a `rateWithSig` redeploy if time allows after M4.

## D17. The facilitator relays agent task approvals (Nov 25)

`approve_task` must work without gas, like every other agent action (D10). The facilitator gained `POST /approve` (`{taskId, signature}`) that relays `approveWithSig` through the same checks, daily limits, send queue and activity log as payments. The vault still requires the session's `agentCanApprove` flag, so an owner who leaves it off keeps approval to themselves.

## D18. Plain viem wallet in the web app, plus a dev key on local chains (Nov 25)

The PRD allows wagmi + RainbowKit or a plain injected connector. We use viem directly over `window.ethereum` (connect, add or switch to Aevum, legacy txs, typed-data signing): one small provider, no extra state library. On local chains only, `DEV_WALLET_KEY` makes the browser sign with a fixed key so the full UI can be driven and tested without MetaMask; the server refuses it when `CHAIN_ID` is 44005.

## D19. The web server fetches only public https URLs on Aevum (Nov 25)

Stall metadata, agent cards and the `/sell` endpoint check are URLs that anyone can put on chain or type in, and the web server fetches them. On Aevum it only fetches public `https` hosts (no localhost, private ranges or link-local, no redirects), so the app can't be used to probe the network it runs in. Local chains allow `http` and localhost for development. The check is on the hostname text, not the resolved IP (marked `shortcut:`).

## D20. Owners can close their agents' channels from the web (Nov 25)

The buyer SDK keeps channel state in memory, so an agent that restarts forgets its open channels and their deposits stay locked until someone closes them. The owner console lists every channel of each session with Close (`requestClose`, owner allowed) and, after the window, Get refund (`finalizeClose`). Revoke still closes them all at once. Because streams are pay as you go (D12), the last call before such a restart is never paid; acceptable for the demo, and the agent can avoid it by calling `close_channels` before exiting.

## D21. Agents get gas to rate, and keep their channels across restarts (Nov 25)

Updates D16 and D20. Rating stays a direct `rate` call from the agent key, but the web app now sends the new agent key 0.005 tQDAY when it creates a session (editable, 0 to skip); one rating costs about 0.0001 tQDAY on Aevum. The buyer SDK takes a `channelFile` and the MCP saves open channels to `STATE_DIR` (default `.clawdford`), so a restarted agent resumes its channels and `close_channels` still pays the last call. Saved channels are checked on chain before use (same session and stall, still open); stale ones are dropped and a fresh channel is opened. If the owner closed a channel from the web meanwhile, the agent's close still pays the last call during the close window.

## D22. The MCP ships as one bundled file and a Claude Code plugin (Nov 25)

The workspace packages export TypeScript source, which `npx` cannot run. `pnpm --filter @clawdford/mcp build` bundles the server and the workspace code it uses (aevum, x402, buyer SDK) into `mcp/dist/index.js` with esbuild; only viem, zod and the MCP SDK stay npm dependencies. The Aevum deployment is built into the entry, so `npx -y @clawdford/mcp` needs no repo; other chains still read `deployments/<chainId>.json`. The Claude Code plugin (`claude-plugin/`, listed by `.claude-plugin/marketplace.json`) runs that package and takes the session key as a sensitive `userConfig` option, so it lives in the OS secure store instead of a settings file. It adds a "how to shop" skill (budget first, refusals are protection, close channels at the end) and `/clawdford:budget`. Publishing to npm needs the owner's npm account and the `@clawdford` scope.

## D23. Stall metadata and agent cards are static files in the repo (Nov 26)

We are not hosting the facilitator and sellers (judges review at unknown times, and an always-on server mostly sleeps). Names, descriptions and agent cards are static, so they live in `market/<chainId>/` and the chain points at their `raw.githubusercontent.com` URLs: free public https that the web app's fetch guard (D19) accepts. The paid endpoints still point at the demo machine, so live buying works while the stack runs there; everything else (stalls, receipts, ratings, payee badges) reads from the chain and GitHub at any time. A card on GitHub proves less than one served from the seller's own domain, since the domain in the identity is not checked against it; acceptable for the demo fixtures.
