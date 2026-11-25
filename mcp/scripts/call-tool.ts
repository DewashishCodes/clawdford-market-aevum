// Runs one MCP tool as the dev-stack agent, through a real MCP client: pnpm call-tool <tool> ['<json args>']
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, json = "{}"] = process.argv.slice(2);
if (!name) throw new Error("usage: pnpm call-tool <tool> ['<json args>']");
const cfg = JSON.parse(readFileSync(new URL("../dev-mcp.json", import.meta.url), "utf8")).mcpServers["clawdford-market"];
const client = new Client({ name: "call-tool", version: "0" });
await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env } as Record<string, string>, stderr: "ignore" }));
const r = (await client.callTool({ name, arguments: JSON.parse(json) })) as { isError?: boolean; content: { text: string }[] };
console.log(r.isError ? "ERROR" : "OK", r.content[0]?.text);
await client.close();
