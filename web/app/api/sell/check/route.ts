import { NextResponse } from "next/server";
import { ctx } from "@/lib/server/ctx";
import { checkSeller } from "@/lib/server/queries";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { endpoint?: string; payee?: string; agentCardURI?: string; method?: string };
  if (typeof body.endpoint !== "string" || typeof body.payee !== "string" || typeof body.agentCardURI !== "string") {
    return NextResponse.json({ ok: false, problems: ["endpoint, payee and agentCardURI are required"] }, { status: 400 });
  }
  return NextResponse.json(await checkSeller(ctx(), { endpoint: body.endpoint, payee: body.payee, agentCardURI: body.agentCardURI, method: body.method }));
}
