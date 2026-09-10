export const MAX_INQUIRY_BYTES = 32 * 1024;

/** Enforce actual bytes even for chunked requests or a false Content-Length. */
export async function readInquiryBody(request: Request): Promise<
  { body: Record<string, unknown> } | { status: 400 | 413; error: string }
> {
  const tooLarge = { status: 413 as const, error: "Application is too large. Shorten your message and try again." };
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_INQUIRY_BYTES) return tooLarge;
  const reader = request.body?.getReader();
  if (!reader) return { status: 400, error: "A JSON object body is required." };
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INQUIRY_BYTES) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Not an object");
    return { body: body as Record<string, unknown> };
  } catch {
    await reader.cancel().catch(() => {});
    return { status: 400, error: "A JSON object body is required." };
  } finally {
    reader.releaseLock();
  }
}
