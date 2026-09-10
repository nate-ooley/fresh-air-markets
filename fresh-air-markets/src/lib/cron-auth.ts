import { createHash, timingSafeEqual } from "node:crypto";

export function cronSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

/** Constant-time comparison prevents a scheduler credential oracle. */
export function cronAuthorized(request: Request, secret: string | undefined): boolean {
  if (!cronSecretConfigured(secret)) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
