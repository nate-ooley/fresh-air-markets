import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getSessionAccountId } from "@/lib/auth";
import { Booth } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Dashboard: move / rename / reprice a booth (drag-and-drop calls this). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: Partial<Booth> = {};
  if (body.x !== undefined) patch.x = Math.max(0, Math.min(1200, Number(body.x) || 0));
  if (body.y !== undefined) patch.y = Math.max(0, Math.min(820, Number(body.y) || 0));
  if (body.w !== undefined) patch.w = Math.max(40, Number(body.w) || 40);
  if (body.h !== undefined) patch.h = Math.max(40, Number(body.h) || 40);
  if (body.label !== undefined) patch.label = String(body.label).trim().slice(0, 8);
  if (body.zone !== undefined) patch.zone = String(body.zone).trim();
  if (body.pricePerDay !== undefined) patch.pricePerDay = Math.max(0, Number(body.pricePerDay) || 0);

  const store = await getStore();
  const booth = await store.updateBooth(marketId, id, patch);
  if (!booth) return NextResponse.json({ error: "Booth not found." }, { status: 404 });
  return NextResponse.json({ booth });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const store = await getStore();
  const ok = await store.deleteBooth(marketId, id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Booth not found." }, { status: 404 });
}
