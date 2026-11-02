import { randomUUID } from "node:crypto";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: Sql | undefined;
function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent note storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5 });
  return client;
}

/**
 * Private market-manager notes on a vendor. They hang off the application, so
 * staff can use them at any stage, paid or not. Vendors never see them.
 */

export const MAX_NOTE_LENGTH = 2000;

export interface VendorNote { id: string; body: string; authorName: string; createdAt: string }

export async function listVendorNotes(marketId: string, applicationId: string, sql: Sql = configuredClient()): Promise<VendorNote[]> {
  const rows = await sql<{ id: string; body: string; author_name: string; created_at: Date }[]>`
    SELECT id, body, author_name, created_at FROM fame_vendor_notes
    WHERE market_id = ${marketId} AND application_id = ${applicationId} AND removed_at IS NULL
    ORDER BY created_at DESC, id`;
  return rows.map(row => ({ id: row.id, body: row.body, authorName: row.author_name, createdAt: new Date(row.created_at).toISOString() }));
}

export type AddNoteResult = { kind: "saved"; note: VendorNote } | { kind: "not_found" } | { kind: "invalid"; error: string };

export async function addVendorNote(input: {
  marketId: string; applicationId: string; body: unknown; authorName: string; actorAccountId: string; now?: Date;
}, sql: Sql = configuredClient()): Promise<AddNoteResult> {
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!body) return { kind: "invalid", error: "Write a note first." };
  if (body.length > MAX_NOTE_LENGTH) return { kind: "invalid", error: `Keep a note under ${MAX_NOTE_LENGTH} characters.` };
  const [application] = await sql<{ id: string }[]>`SELECT id FROM fame_applications WHERE id = ${input.applicationId} AND market_id = ${input.marketId}`;
  if (!application) return { kind: "not_found" };
  const id = randomUUID();
  const now = input.now ?? new Date();
  const authorName = input.authorName.trim().slice(0, 200) || "Market staff";
  await sql`INSERT INTO fame_vendor_notes (id, market_id, application_id, body, author_name, created_by_account_id, created_at)
    VALUES (${id}, ${input.marketId}, ${input.applicationId}, ${body}, ${authorName}, ${input.actorAccountId}, ${now})`;
  return { kind: "saved", note: { id, body, authorName, createdAt: now.toISOString() } };
}

/** Takes a note off the vendor's page; the row stays on record as removed. */
export async function removeVendorNote(input: { marketId: string; noteId: string; now?: Date }, sql: Sql = configuredClient()): Promise<boolean> {
  const rows = await sql`UPDATE fame_vendor_notes SET removed_at = ${input.now ?? new Date()}
    WHERE id = ${input.noteId} AND market_id = ${input.marketId} AND removed_at IS NULL RETURNING id`;
  return rows.length === 1;
}

/** The name shown on a note: the signed-in staff member's, or "Owner" for the original owner sign-in. */
export async function staffDisplayName(marketId: string, userId: string | null, sql: Sql = configuredClient()): Promise<string> {
  if (!userId) return "Owner";
  const [row] = await sql<{ name: string; email: string }[]>`SELECT name, email FROM fame_staff_users WHERE id = ${userId} AND market_id = ${marketId}`;
  return row?.name?.trim() || row?.email || "Market staff";
}
