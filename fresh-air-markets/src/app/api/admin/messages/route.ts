import { NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { listContactMessages, listSubscribers } from "@/lib/portal-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Contact messages and newsletter signups for the signed-in market. */
export async function GET() {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
  try {
    const [messages, subscribers] = await Promise.all([listContactMessages(marketId), listSubscribers(marketId)]);
    return NextResponse.json({ messages, subscribers }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Messages are unavailable." }, { status: 503 });
  }
}
