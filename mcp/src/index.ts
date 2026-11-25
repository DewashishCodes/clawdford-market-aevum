// Clawdford Market MCP server over stdio. Holds only the session key; everything else comes from the chain.
// Configure it through env in the MCP client config (see mcp/README.md). It never reads the repo's .env.
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseUnits, type Hex } from "viem";
import { createMcpServer } from "./tools.js";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`${name} is not set (see mcp/README.md)`);
  return v;
};

const server = createMcpServer({
  chainId: Number(env("CHAIN_ID", "44005")),
  rpcUrl: process.env.RPC_URL || undefined,
  sessionKey: env("SESSION_KEY") as Hex,
  sessionId: BigInt(env("SESSION_ID")),
  perCallBudget: parseUnits(env("BUDGET_PER_CALL", "0.2"), 6),
  channelDeposit: parseUnits(env("CHANNEL_DEPOSIT", "0.05"), 6),
  facilitatorUrl: env("FACILITATOR_URL", "http://127.0.0.1:4020"),
  skillsDir: resolve(env("SKILLS_DIR", ".claude/skills")),
});

await server.connect(new StdioServerTransport());
// stdout carries the protocol; logs go to stderr.
console.error("clawdford-market MCP server ready");
