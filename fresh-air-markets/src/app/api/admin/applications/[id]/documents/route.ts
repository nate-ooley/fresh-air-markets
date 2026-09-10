import { NextRequest, NextResponse } from "next/server";
import { getSessionAccountId } from "@/lib/auth";
import { validApplicationDocumentId, MAX_APPLICATION_DOCUMENT_BYTES } from "@/lib/application-document";
import { listApplicationDocuments, uploadApplicationDocumentAsManager } from "@/lib/application-document-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Documents on file for one market-owned application. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  if (!validApplicationDocumentId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Document storage is not configured." }, { status: 503, headers });
  try {
    return NextResponse.json({ documents: await listApplicationDocuments(id, marketId) }, { headers });
  } catch {
    return NextResponse.json({ error: "Documents are unavailable." }, { status: 503, headers });
  }
}

const REJECTION_MESSAGES: Record<string, string> = {
  invalid_request: "Choose a document type and a file.",
  invalid_filename: "The file name is not usable. Rename it and try again.",
  unsupported_type: "Only PDF, PNG and JPEG files are accepted.",
  extension_mismatch: "The file extension does not match its type.",
  signature_mismatch: "The file contents do not match its type. Export it again as a PDF, PNG or JPEG.",
  invalid_size: "The file is empty.",
  file_too_large: "The file is larger than 10 MB.",
};

/**
 * Staff upload of a vendor document. The signed-in market session is the only
 * tenant selector; the browser never supplies a market, storage key or status.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const marketId = await getSessionAccountId();
  if (!marketId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Same-origin upload is required." }, { status: 403, headers });
  }
  const { id } = await params;
  if (!validApplicationDocumentId(id)) return NextResponse.json({ error: "Invalid application ID." }, { status: 400, headers });
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  if (!process.env.DATABASE_URL || !locationId) {
    return NextResponse.json({ error: "Document storage is not configured." }, { status: 503, headers });
  }
  let form: FormData;
  try { form = await request.formData(); } catch {
    return NextResponse.json({ error: "A multipart form with a file is required." }, { status: 400, headers });
  }
  const kind = form.get("kind");
  const file = form.get("file");
  if (typeof kind !== "string" || !(file instanceof File)) {
    return NextResponse.json({ error: REJECTION_MESSAGES.invalid_request }, { status: 400, headers });
  }
  if (file.size > MAX_APPLICATION_DOCUMENT_BYTES) {
    return NextResponse.json({ error: REJECTION_MESSAGES.file_too_large }, { status: 413, headers });
  }
  let result;
  try {
    result = await uploadApplicationDocumentAsManager({
      applicationId: id, marketId, locationId, kind,
      filename: file.name, declaredContentType: file.type, body: file.stream(),
    });
  } catch {
    return NextResponse.json({ error: "Document upload is unavailable. Try again." }, { status: 503, headers });
  }
  if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  if (result.kind === "rejected") {
    return NextResponse.json({ error: REJECTION_MESSAGES[result.code] ?? "The file was not accepted.", code: result.code }, { status: 400, headers });
  }
  if (result.kind === "failed") return NextResponse.json({ error: "Document upload is unavailable. Try again." }, { status: 503, headers });
  const { document } = result;
  return NextResponse.json({
    duplicate: result.kind === "duplicate",
    document: {
      id: document.id, kind: document.kind, version: document.version, filename: document.file.filename,
      contentType: document.file.contentType, sizeBytes: document.file.sizeBytes,
      validationState: document.validationState, reviewState: document.reviewState, isCurrent: document.isCurrent,
    },
  }, { status: result.kind === "captured" ? 201 : 200, headers });
}
