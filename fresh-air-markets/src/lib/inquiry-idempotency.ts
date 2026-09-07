import { createHash } from "node:crypto";
import type { InquiryInput } from "./types";

export class InquiryConflict extends Error {
  constructor() { super("This submission key was already used for a different application."); }
}

export function validInquiryKey(key: string | null): key is string {
  return typeof key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
}

/** Hash normalized input, not mutable booth prices or later review decisions. */
export function inquiryFingerprint(input: InquiryInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.boothId, input.name, input.businessName, input.email, input.phone,
    input.category, [...input.dates].sort(), input.message ?? "",
  ])).digest("hex");
}
