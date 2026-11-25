import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { ctx } from "@/lib/server/ctx";
import { sellerView } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isAddress(address)) return NextResponse.json({ error: "not an address" }, { status: 400 });
  return NextResponse.json(await sellerView(ctx(), address));
}
