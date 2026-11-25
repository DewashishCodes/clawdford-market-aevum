---
name: budget
description: Show the Clawdford Market session budget, spend and open channels.
disable-model-invocation: true
allowed-tools: mcp__plugin_clawdford_market__wallet_status
---

Call `wallet_status` and report in a few lines:

- session id and whether it is active, revoked or expired (with the expiry time)
- spent today and in total against the daily and total caps, and what is left
- the per-payment cap and the allowed categories
- open stream channels with their deposits and what is owed, and a reminder that `close_channels` returns unused deposits

If the tool fails because the session key or id is not set, say how to set them: `/plugin` and configure the clawdford plugin with the values from the owner console.
