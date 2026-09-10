import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { validApplicationDocumentId } from "@/lib/application-document";
import { readApplicationDocumentFile } from "@/lib/application-document-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Private bytes of one market-owned document for staff review; never cached or embeddable elsewhere. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  if (!validApplicationDocumentId(id)) return NextResponse.json({ error: "Invalid document ID." }, { status: 400, headers });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Document storage is not configured." }, { status: 503, headers });
  let file;
  try { file = await readApplicationDocumentFile(id, marketId); } catch {
    return NextResponse.json({ error: "Document is unavailable." }, { status: 503, headers });
  }
  if (!file) return NextResponse.json({ error: "Document not found." }, { status: 404, headers });
  return new NextResponse(new Uint8Array(file.body), {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": file.contentType,
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": contentDisposition(file.filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
