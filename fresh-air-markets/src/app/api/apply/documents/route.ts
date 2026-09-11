import { NextRequest, NextResponse } from "next/server";
import { MAX_APPLICATION_DOCUMENT_BYTES } from "@/lib/application-document";
import { uploadApplicationDocumentAsManager } from "@/lib/application-document-upload";
import { verifyApplicationUploadToken } from "@/lib/application-upload-token";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { readPortalConfig } from "@/lib/portal-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

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
 * Applicant document upload, allowed only with the signed token issued by the
 * application submission for that exact application. The file goes through
 * the same streaming type/size/signature checks as staff uploads and lands in
 * the same ledger for staff review.
 */
export async function POST(request: NextRequest) {
  const config = readPortalConfig();
  if (!config) return NextResponse.json({ error: "Uploads are not available right now." }, { status: 503, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Same-origin upload is required." }, { status: 403, headers });
  try {
    const decision = await consumeInquiryLimit("ip", inquiryClient(request.headers));
    if (!decision.allowed) return NextResponse.json({ error: "Too many uploads. Please wait a few minutes." }, { status: 429, headers: { ...headers, "Retry-After": String(decision.retryAfterSeconds) } });
  } catch { return NextResponse.json({ error: "Uploads are not available right now." }, { status: 503, headers }); }
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "A file is required." }, { status: 400, headers }); }
  const grant = verifyApplicationUploadToken(form.get("token"));
  if (!grant || grant.marketId !== config.marketId) return NextResponse.json({ error: "This upload link has expired. Reply to your confirmation email with the document instead." }, { status: 401, headers });
  const kind = form.get("kind");
  const file = form.get("file");
  if (typeof kind !== "string" || !(file instanceof File)) return NextResponse.json({ error: REJECTION_MESSAGES.invalid_request }, { status: 400, headers });
  if (file.size > MAX_APPLICATION_DOCUMENT_BYTES) return NextResponse.json({ error: REJECTION_MESSAGES.file_too_large }, { status: 413, headers });
  let result;
  try {
    result = await uploadApplicationDocumentAsManager({
      applicationId: grant.applicationId, marketId: config.marketId, locationId: config.locationId, kind,
      filename: file.name, declaredContentType: file.type, body: file.stream(), actor: "applicant",
    });
  } catch { return NextResponse.json({ error: "Upload is unavailable. Try again." }, { status: 503, headers }); }
  if (result.kind === "not_found") return NextResponse.json({ error: "Application not found." }, { status: 404, headers });
  if (result.kind === "rejected") return NextResponse.json({ error: REJECTION_MESSAGES[result.code] ?? "The file was not accepted.", code: result.code }, { status: 400, headers });
  if (result.kind === "failed") return NextResponse.json({ error: "Upload is unavailable. Try again." }, { status: 503, headers });
  return NextResponse.json({ ok: true, duplicate: result.kind === "duplicate", kind: result.document.kind, version: result.document.version }, { status: result.kind === "captured" ? 201 : 200, headers });
}
