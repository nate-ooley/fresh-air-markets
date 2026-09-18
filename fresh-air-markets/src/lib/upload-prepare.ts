/**
 * Browser-side preparation of a document before upload. Vercel refuses request
 * bodies over 4.5 MB before the route runs, and phone photos are routinely
 * bigger than that, so images are re-encoded smaller in the browser first.
 * PDFs cannot be shrunk here; oversized ones get a clear message instead of
 * a raw gateway error.
 */

/** Keep comfortably under Vercel's 4.5 MB function payload limit (multipart overhead included). */
export const MAX_UPLOAD_BYTES = 4_000_000;
const SHRINK_ABOVE_BYTES = 2_500_000;
const MAX_EDGE_PX = 2400;
const JPEG_QUALITY = 0.85;

export type UploadPlan = { action: "send" } | { action: "shrink" } | { action: "reject"; reason: string };

function isImage(file: { type: string; name: string }): boolean {
  return /^image\//.test(file.type) || /\.(png|jpe?g|heic|heif|webp)$/i.test(file.name);
}

function isHeic(file: { type: string; name: string }): boolean {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/** Decides what to do with a chosen file. Pure, so it is unit-testable. */
export function uploadPlan(file: { type: string; name: string; size: number }): UploadPlan {
  if (isImage(file)) {
    if (isHeic(file) || file.size > SHRINK_ABOVE_BYTES) return { action: "shrink" };
    return { action: "send" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { action: "reject", reason: "This PDF is larger than 4 MB, which is more than we can accept in one upload. Export a smaller PDF, or take a clear photo of each page and upload that instead." };
  }
  return { action: "send" };
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(file).catch(() => loadImageElement(file));
  return loadImageElement(file);
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode_failed")); };
    image.src = url;
  });
}

/** Re-encodes an image as a JPEG no larger than MAX_EDGE_PX on its longest side. */
export async function shrinkImage(file: File): Promise<File> {
  const bitmap = await loadBitmap(file);
  const width = "naturalWidth" in bitmap ? bitmap.naturalWidth : bitmap.width;
  const height = "naturalHeight" in bitmap ? bitmap.naturalHeight : bitmap.height;
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("encode_failed");
  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
}

/**
 * Returns the file to upload, shrinking images when needed. Throws with a
 * vendor-readable message when the file cannot be made acceptable.
 */
export async function prepareUpload(file: File): Promise<File> {
  const plan = uploadPlan(file);
  if (plan.action === "reject") throw new Error(plan.reason);
  if (plan.action === "send") return file;
  let shrunk: File;
  try { shrunk = await shrinkImage(file); }
  catch {
    if (isHeic(file)) throw new Error("This photo format (HEIC) can't be read by your browser. On iPhone, open the photo, tap Share, choose Copy or Save as JPEG, or take a screenshot of it and upload that.");
    throw new Error("This photo could not be prepared for upload. Try a screenshot of it, or a PDF.");
  }
  if (shrunk.size > MAX_UPLOAD_BYTES) throw new Error("This photo is still too large after shrinking. Try a screenshot of it, or a PDF.");
  return shrunk;
}

/** What to tell someone when the gateway refused the request before the site saw it. */
export function uploadFailureMessage(status: number, payloadError: unknown): string {
  if (typeof payloadError === "string" && payloadError) return payloadError;
  if (status === 413) return "That file is too large to send in one upload (about 4 MB max). Try a smaller photo or PDF.";
  if (status >= 500) return "The upload service didn't respond. Check your connection and try again in a minute.";
  return "The file was not accepted.";
}
