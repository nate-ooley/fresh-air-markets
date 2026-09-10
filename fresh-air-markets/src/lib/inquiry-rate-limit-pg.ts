import postgres from "postgres";
import type { LimitDecision, LimitPolicy } from "./inquiry-rate-limit";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;

/** A single UPSERT serializes competing requests across connections/instances.
 * Uses the database clock; blocked attempts never extend the original window.
 * Apply docs/migrations/002-inquiry-rate-limit.sql before deployment.
 */
export async function consumePgInquiryLimit(key: string, policy: LimitPolicy, sql?: Sql): Promise<LimitDecision> {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error("Persistent inquiry limiter is unavailable.");
    client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
    sql = client;
  }
  const [row] = await sql<{ hits: number; retry_after: string }[]>`
    INSERT INTO fame_inquiry_limits AS bucket (bucket_key, hits, resets_at)
    VALUES (${key}, 1, statement_timestamp() + ${policy.seconds} * interval '1 second')
    ON CONFLICT (bucket_key) DO UPDATE SET
      hits = CASE WHEN bucket.resets_at <= statement_timestamp() THEN 1
                  ELSE LEAST(bucket.hits + 1, ${policy.limit + 1}) END,
      resets_at = CASE WHEN bucket.resets_at <= statement_timestamp()
                       THEN statement_timestamp() + ${policy.seconds} * interval '1 second'
                       ELSE bucket.resets_at END
    RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM resets_at - statement_timestamp())))::text AS retry_after`;
  if (!row) throw new Error("Inquiry limit could not be verified.");
  return { allowed: row.hits <= policy.limit, retryAfterSeconds: Number(row.retry_after) };
}
