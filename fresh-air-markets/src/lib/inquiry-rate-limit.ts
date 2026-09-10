import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type LimitDecision = { allowed: boolean; retryAfterSeconds: number };
export type LimitPolicy = { limit: number; seconds: number };
export const INQUIRY_IP_POLICY: LimitPolicy = { limit: 20, seconds: 600 };
export const INQUIRY_EMAIL_POLICY: LimitPolicy = { limit: 5, seconds: 3600 };

/** Only the Vercel edge's overwritten header is trusted. Self-hosted instances
 * share an unknown-client bucket until a trusted proxy adapter is implemented.
 */
export function inquiryClient(headers: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VERCEL === "1" ? headers.get("x-forwarded-for")?.trim() : undefined;
  if (!raw || !isIP(raw)) return "unknown";
  return isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname : raw;
}

export function inquiryBucket(kind: "ip" | "email", subject: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.AUTH_SECRET?.trim();
  if (env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
    throw new Error("Inquiry limiter requires a private signing secret.");
  }
  return createHmac("sha256", secret || "local-inquiry-limiter-only")
    .update(JSON.stringify(["inquiry-v1", kind, subject])).digest("hex");
}

/** Bounded, single-process development/demo implementation. Never used in production. */
export class MemoryInquiryLimiter {
  private buckets = new Map<string, { hits: number; reset: number }>();
  constructor(private now = Date.now, private maxBuckets = 10000) {}

  async consume(key: string, policy: LimitPolicy): Promise<LimitDecision> {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Do not evict active limits: that would allow rotating identities to reset them.
      if (this.buckets.size >= this.maxBuckets) return { allowed: false, retryAfterSeconds: policy.seconds };
      bucket = { hits: 0, reset: now + policy.seconds * 1000 };
      this.buckets.set(key, bucket);
    }
    bucket.hits = Math.min(bucket.hits + 1, policy.limit + 1);
    return { allowed: bucket.hits <= policy.limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.reset - now) / 1000)) };
  }
}

const memory = new MemoryInquiryLimiter();
export async function consumeInquiryLimit(kind: "ip" | "email", subject: string): Promise<LimitDecision> {
  const key = inquiryBucket(kind, subject);
  const policy = kind === "ip" ? INQUIRY_IP_POLICY : INQUIRY_EMAIL_POLICY;
  if (process.env.DATABASE_URL) {
    const { consumePgInquiryLimit } = await import("./inquiry-rate-limit-pg");
    return consumePgInquiryLimit(key, policy);
  }
  if (process.env.NODE_ENV === "production") throw new Error("Persistent inquiry limiter is unavailable.");
  return memory.consume(key, policy);
}
