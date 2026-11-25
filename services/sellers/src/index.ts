import { createSellersApp } from "./app.js";
import { STALL_KEYS, CATALOG } from "./catalog.js";
import { baseUrl, chainId, env, port, readStalls, rpcUrl, sellerKey } from "./env.js";
import { openAiLlm } from "./llm.js";
import { stallIdsOf } from "./seed.js";

const seeded = readStalls();
const llmBase = env("LLM_BASE_URL", "http://127.0.0.1:11434/v1"); // PRD default: local Ollama
const llmModel = env("LLM_MODEL", "qwen2.5");
const dbDir = env("SELLERS_DB_DIR", ".");

const { app, sellers } = createSellersApp({
  chainId,
  rpcUrl,
  stalls: stallIdsOf(seeded),
  sellerKey: sellerKey(),
  facilitatorUrl: env("FACILITATOR_URL", "http://127.0.0.1:4020"),
  baseUrl,
  shadyPayee: env("SHADY_PAYEE", "0x000000000000000000000000000000000000dEaD") as `0x${string}`,
  llm: openAiLlm({ baseUrl: llmBase, model: llmModel, apiKey: process.env.LLM_API_KEY || undefined }),
  reviewToken: env("REVIEW_TOKEN"),
  dbPath: (key) => `${dbDir}/seller-${key}.sqlite`,
});

const settleMs = Number(env("SETTLE_INTERVAL_MS", "30000"));
for (const key of STALL_KEYS) if (CATALOG[key].mode === "stream") sellers[key].startSettler(settleMs);

app.listen(port, () => {
  console.log(`sellers on :${port} (${baseUrl}), chain ${chainId}, LLM ${llmModel} at ${llmBase}`);
  for (const key of STALL_KEYS) console.log(`  stall ${seeded.stalls[key]!.padStart(3)}  ${CATALOG[key].mode.padEnd(7)} /s/${key}`);
});
