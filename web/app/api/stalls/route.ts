import { NextResponse } from "next/server";
import { ctx } from "@/lib/server/ctx";
import { listStalls } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const category = new URL(req.url).searchParams.get("category");
  const stalls = await listStalls(ctx());
  return NextResponse.json(category ? stalls.filter((s) => s.category === category) : stalls);
}
