// Local demo stack: a fork of Aevum (real tUSD8) with the protocol deployed, the facilitator, the 8 seeded demo
// stalls and a funded owner session; writes mcp/dev-mcp.json for `claude --mcp-config`. Ctrl+C stops everything.
// Usage (from mcp/): pnpm dev-stack [--anvil]. LLM stalls use LLM_BASE_URL / LLM_MODEL / LLM_API_KEY when set, else a canned reply.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startChain } from "@clawdford/testkit";
import { startDemoMarket, REVIEW_TOKEN } from "@clawdford/sellers/test-market";
import { openAiLlm } from "@clawdford/sellers/llm";

const fork = !process.argv.includes("--anvil");
const t = await startChain({ fork, port: 8551 });
const llm = process.env.LLM_BASE_URL ? openAiLlm({ baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL ?? "qwen2.5", apiKey: process.env.LLM_API_KEY }) : undefined;
const market = await startDemoMarket(t, { ownerDeposit: 1_400_000n, claimThreshold: 10_000n, llm });
const { agentKey, sessionId } = await market.openSession({ agentCanApprove: true });

const mcpDir = fileURLToPath(new URL("..", import.meta.url));
const tsx = pathToFileURL(createRequire(join(mcpDir, "package.json")).resolve("tsx/esm")).href;
const config = {
  mcpServers: {
    "clawdford-market": {
      command: process.execPath,
      args: ["--import", tsx, join(mcpDir, "src", "index.ts")],
      env: { CHAIN_ID: String(t.chainId), RPC_URL: t.rpc, SESSION_KEY: agentKey, SESSION_ID: sessionId.toString(), FACILITATOR_URL: market.facilitator, BUDGET_PER_CALL: "0.2", SKILLS_DIR: join(mcpDir, ".dev-skills") },
    },
  },
};
const configPath = join(mcpDir, "dev-mcp.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil key 2, the owner here
console.log(`chain        ${t.chainId} at ${t.rpc} (${fork ? "fork of Aevum" : "plain anvil"})`);
console.log(`facilitator  ${market.facilitator}  (activity: ${market.facilitator}/activity)`);
console.log(`sellers      ${market.base}  (catalog: ${market.base}/catalog)`);
console.log(`session      ${sessionId}, caps 0.2 per payment / 1.0 a day / 2.0 total, agent may approve tasks`);
console.log(`review queue curl -H "authorization: Bearer ${REVIEW_TOKEN}" ${market.base}/s/review/queue`);
console.log(`approve      curl -X POST -H "content-type: application/json" -H "authorization: Bearer ${REVIEW_TOKEN}" -d '{"approved":true,"note":"ok"}' ${market.base}/s/review/<taskId>/decision`);
console.log(`revoke       cast send ${t.d.AgentVault} "revokeSession(uint256)" ${sessionId} --rpc-url ${t.rpc} --legacy --private-key ${OWNER_KEY}`);
console.log(`mcp config   ${configPath}  ->  claude --mcp-config ${configPath}`);

const stop = () => {
  market.close();
  t.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
