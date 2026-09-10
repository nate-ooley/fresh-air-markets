import { readObjectBody } from "@/lib/request-body";
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getSessionAccountId } from "@/lib/auth";
import { Booth } from "@/lib/types";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/** Dashboard: add a new booth to the session's market map. */
export async function POST(req: NextRequest) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const booth: Booth = {
    id: randomUUID().slice(0, 8),
    marketId,
    label: String(body.label ?? "NEW").trim().slice(0, 8) || "NEW",
    zone: String(body.zone ?? "Custom").trim(),
    x: Number(body.x) || 540,
    y: Number(body.y) || 500,
    w: Math.max(40, Number(body.w) || 92),
    h: Math.max(40, Number(body.h) || 72),
    pricePerDay: Math.max(0, Number(body.pricePerDay) || 50),
    active: true,
  };
  const store = await getStore();
  await store.createBooth(booth);
  return NextResponse.json({ booth }, { status: 201 });
}

