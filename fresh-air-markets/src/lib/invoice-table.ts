import type postgres from "postgres";

type QuerySql = ReturnType<typeof postgres> | postgres.TransactionSql;
let ready = false;

/**
 * Billing ships before its database update (032) may be applied. Until the
 * invoice table exists, every other screen must behave as if no booking is
 * on an invoice. Once seen, the answer is remembered for this process.
 */
export async function invoicesReady(sql: QuerySql): Promise<boolean> {
  if (ready) return true;
  const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass('fame_invoices') IS NOT NULL AS present`;
  ready = Boolean(row?.present);
  return ready;
}
