# Static stall metadata and agent cards

Public copies of what the sellers server serves at `/catalog` and `/.well-known/agent-card.json`, per chain. The demo stalls on Aevum point here (through `raw.githubusercontent.com`), so the web app and agents can read stall names and confirm payees while the paid endpoints run on a demo machine.

- `catalog.json`: one entry per stall; a stall's `metadataURI` is `<url>/catalog.json#<key>`.
- `agent-card.json`, `shady-agent-card.json`: the agent cards of the two seller identities (payee and stall ids). The shady card names a different payee on purpose: it is the demo fixture that agents must refuse.

To change them: edit, merge to `main`, then `META_BASE=https://raw.githubusercontent.com/DewashishCodes/clawdford-market-aevum/main/market/44005 pnpm --filter @clawdford/sellers repoint` (only sends transactions for addresses that differ).
