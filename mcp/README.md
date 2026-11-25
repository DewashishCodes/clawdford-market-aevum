# Clawdford Market MCP server

Lets Claude Code, Codex or any MCP client buy AI services on Clawdford Market. It runs over stdio and holds **only the agent's session key**: the owner's funds stay in `AgentVault`, every limit (per payment, per day, total, categories, expiry, revoke) is enforced on chain, and the agent never needs gas.

## Tools

| Tool | Does |
|---|---|
| `market_search` | Find stalls by text, category, mode or max unit price. Shows price, rating, usage, which tool to call and whether the session may pay that category. |
| `wallet_status` | Session caps, spent today and in total, remaining, expiry, revoked, open channels. |
| `call_service` | Call an `exact` or `stream` stall (GET with `query`, or POST with a JSON `body`). Returns the result plus cost and receipt. |
| `buy_license` / `download_skill` | Buy a license stall. `download_skill` installs the skill as `<SKILLS_DIR>/<name>/SKILL.md` (never overwrites an existing skill). |
| `create_task` / `get_task` / `approve_task` | Escrowed tasks. `get_task` checks the result against the on-chain hash. `approve_task` releases gaslessly through the facilitator (needs the owner's "agent can approve" setting). |
| `rate_service` | Rate a paid call 1 to 5 by receipt id. The agent key needs a little tQDAY for this one (D16); the web app sends it 0.005 tQDAY when it creates the session. |
| `close_channels` | Close open stream channels; the unused deposit returns to the owner after the close window. |

Every result includes a `budget` block (`spentToday`, `spentTotal`, `remainingToday`, `remainingTotal`). Payments the buyer SDK or the vault refuse come back as errors with a readable code and `charged: "nothing"`: `PAYEE_MISMATCH`, `OVERPRICED`, `CAP_EXCEEDED`, `SESSION_REVOKED`, `SESSION_EXPIRED`, `CATEGORY_NOT_ALLOWED`, `STALL_NOT_ALLOWED`, `NO_AGENT_CARD`.

Before each payment the server checks that the quote's payee matches the stall's on-chain payee and its agent card (Confirmation of Payee), that the price is at most the on-chain price, and that the call fits `BUDGET_PER_CALL`. It only ever pays a stall's registered endpoint.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_KEY` | (required) | The agent's session key, from the owner console |
| `SESSION_ID` | (required) | The session id |
| `CHAIN_ID` | `44005` | Aevum testnet (`440050` for a local fork) |
| `RPC_URL` | chain default | RPC endpoint |
| `FACILITATOR_URL` | `http://127.0.0.1:4020` | Relays gasless task approvals |
| `BUDGET_PER_CALL` | `0.2` | Most one call may cost, in tUSD8, checked before signing |
| `CHANNEL_DEPOSIT` | `0.05` | Deposit for each stream channel, in tUSD8 |
| `SKILLS_DIR` | `.claude/skills` | Where `download_skill` installs skills (relative to the client's working directory) |
| `STATE_DIR` | `.clawdford` | Open stream channels, saved so a restarted agent resumes them and `close_channels` still pays the last call |

The server never reads the repo's `.env`; give it only these values.

## Claude Code

From the repo root, with the session from the owner console:

```sh
claude mcp add clawdford-market \
  -e SESSION_KEY=0x... -e SESSION_ID=1 -e CHAIN_ID=44005 \
  -e FACILITATOR_URL=https://<facilitator host> \
  -- pnpm --silent --filter @clawdford/mcp start
```

Or as JSON (`.mcp.json` or `claude --mcp-config file.json`):

```json
{
  "mcpServers": {
    "clawdford-market": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/aevum_hackathon/mcp", "start"],
      "env": { "SESSION_KEY": "0x...", "SESSION_ID": "1", "CHAIN_ID": "44005", "FACILITATOR_URL": "https://<facilitator host>" }
    }
  }
}
```

On Windows, if `pnpm` is not found as a command, use `"command": "pnpm.cmd"`.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.clawdford-market]
command = "pnpm"
args = ["--silent", "--dir", "/path/to/aevum_hackathon/mcp", "start"]
env = { SESSION_KEY = "0x...", SESSION_ID = "1", CHAIN_ID = "44005", FACILITATOR_URL = "https://<facilitator host>" }
```

## Try it locally on a fork

```sh
cd mcp
pnpm dev-stack          # fork of Aevum + facilitator + 8 seeded stalls + a funded session; writes dev-mcp.json
claude --mcp-config dev-mcp.json
```

`dev-stack` prints the review queue, approve and revoke commands. Without `LLM_BASE_URL` set, LexModel and the draft judge return canned replies. Then try the demo prompt: "Review this NDA and write a risk memo. Budget 1 tUSD8." A recorded run is in `docs/demo-runs/2026-11-25-fork.md`.

## Tests

`MCP_E2E=anvil pnpm exec vitest run test/e2e.test.ts` (or `fork`) drives every tool through a real MCP client against the seeded demo market, including the Shady refusal and the revoke kill switch.
