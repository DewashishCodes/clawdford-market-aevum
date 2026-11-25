import { NextResponse } from "next/server";
import { ctx } from "@/lib/server/ctx";
import { activity } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await activity(ctx()));
}
