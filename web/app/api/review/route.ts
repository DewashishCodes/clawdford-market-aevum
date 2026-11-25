import { NextResponse } from "next/server";
import { stallRegistryAbi } from "@clawdford/aevum/abis";
import { CATEGORIES } from "@/lib/format";
import { ctx } from "@/lib/server/ctx";
import { allowedUrl } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

/**
 * Proxy to a human-review stall's queue (`<endpoint>/queue`, `<endpoint>/<taskId>/decision`). The reviewer's token comes
 * from the browser and is passed through; this server holds no reviewer secret.
 */
async function reviewEndpoint(stallId: string | null) {
  if (!stallId || !/^\d+$/.test(stallId)) return undefined;
  const c = ctx();
  const s = await c.pub.readContract({ address: c.cfg.deployment.StallRegistry, abi: stallRegistryAbi, functionName: "getStall", args: [BigInt(stallId)] }).catch(() => undefined);
  if (!s || CATEGORIES[s.category] !== "human") return undefined;
  return allowedUrl(c.cfg.chainId, s.endpoint) ? s.endpoint.replace(/\/$/, "") : undefined;
}

async function forward(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), cache: "no-store", redirect: "error" });
    return NextResponse.json(await res.json().catch(() => ({ error: `stall answered ${res.status}` })), { status: res.status });
  } catch {
    return NextResponse.json({ error: "review stall unreachable" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const endpoint = await reviewEndpoint(new URL(req.url).searchParams.get("stallId"));
  if (!endpoint) return NextResponse.json({ error: "not a human review stall" }, { status: 400 });
  return forward(`${endpoint}/queue`, { headers: { authorization: req.headers.get("authorization") ?? "" } });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { stallId?: string; taskId?: string; approved?: boolean; note?: string };
  const endpoint = await reviewEndpoint(body.stallId ?? null);
  if (!endpoint) return NextResponse.json({ error: "not a human review stall" }, { status: 400 });
  if (!body.taskId || !/^\d+$/.test(body.taskId) || typeof body.approved !== "boolean") return NextResponse.json({ error: "taskId and approved are required" }, { status: 400 });
  return forward(`${endpoint}/${body.taskId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: req.headers.get("authorization") ?? "" },
    body: JSON.stringify({ approved: body.approved, note: body.note ?? "" }),
  });
}
