import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  // Workspace packages ship TypeScript source with `.js` import specifiers.
  transpilePackages: ["@clawdford/aevum", "@clawdford/x402"],
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
};

export default config;
