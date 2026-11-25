import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { publicConfig } from "@/lib/server/public-config";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clawdford Market",
  description: "AI services paid per request by agents, under budgets their owners set on Aevum.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = await publicConfig();
  return (
    <html lang="en">
      <body>
        <WalletProvider config={config}>
          <Nav />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-zinc-500">
            {config.chainName} (chain {config.chainId}) · vault <span className="mono">{config.contracts.AgentVault}</span> · testnet only, tUSD8 has no value
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
