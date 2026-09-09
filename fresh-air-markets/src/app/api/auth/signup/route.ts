import { readObjectBody } from "@/lib/request-body";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Vendor applications belong to the existing market form, not SaaS provisioning. */
export async function POST(req: NextRequest) {
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  return NextResponse.json({
    error: "Public market account signup is closed. Use the vendor application form.",
    applicationUrl: "https://freshairmarketsandevents.com/vendors",
  }, { status: 410 });
}
