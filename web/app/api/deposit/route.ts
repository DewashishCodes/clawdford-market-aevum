import { NextResponse } from "next/server";
import { DepositRequest } from "@clawdford/x402";
import { ctx } from "@/lib/server/ctx";

/** Forwards a signed EIP-3009 deposit to the facilitator, which pays the gas (the browser can't reach it cross-origin). */
export async function POST(req: Request) {
  const parsed = DepositRequest.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ success: false, errorReason: "invalid_payload" }, { status: 400 });
  try {
    const res = await fetch(`${ctx().cfg.facilitatorUrl}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(60_000),
    });
    return NextResponse.json(await res.json(), { status: res.ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ success: false, errorReason: "facilitator_unreachable" }, { status: 502 });
  }
}
