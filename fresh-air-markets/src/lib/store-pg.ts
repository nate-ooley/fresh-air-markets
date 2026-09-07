import { randomUUID } from "crypto";
import postgres from "postgres";
import { Account, Booth, Booking, BoothWithAvailability, InquiryInput } from "./types";
import { ApproveResult, Store, decorateBooth } from "./store";
import { DEMO_MARKET_ID, DEMO_PASSWORD, defaultBooths, demoAccount, demoBookings } from "./seed";
import { hashPassword } from "./auth";

type Sql = ReturnType<typeof postgres>;

function client(): Sql {
  const g = globalThis as typeof globalThis & { __marketSql?: Sql };
  if (!g.__marketSql) {
    g.__marketSql = postgres(process.env.DATABASE_URL!, { max: 5, prepare: false });
  }
  return g.__marketSql;
}

let ready: Promise<void> | null = null;

/** Creates the schema and seeds the demo tenant on first connect. */
function init(sql: Sql): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          owner_name TEXT NOT NULL DEFAULT '',
          market_name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          plan TEXT NOT NULL DEFAULT 'starter',
          license_key TEXT NOT NULL,
          license_status TEXT NOT NULL DEFAULT 'trial',
          trial_ends_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS booths (
          id TEXT PRIMARY KEY,
          market_id TEXT NOT NULL,
          label TEXT NOT NULL,
          zone TEXT NOT NULL DEFAULT '',
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          w INTEGER NOT NULL,
          h INTEGER NOT NULL,
          price_per_day NUMERIC NOT NULL DEFAULT 50,
          active BOOLEAN NOT NULL DEFAULT TRUE
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS bookings (
          id TEXT PRIMARY KEY,
          booth_id TEXT NOT NULL REFERENCES booths(id),
          market_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          total_price NUMERIC NOT NULL DEFAULT 0,
          message TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          vendor_name TEXT NOT NULL,
          business_name TEXT NOT NULL,
          email TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT ''
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS booking_dates (
          booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          PRIMARY KEY (booking_id, date)
        )`;
      // Upgrade path for databases created before multi-tenancy.
      await sql`ALTER TABLE booths ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT ${DEMO_MARKET_ID}`;
      await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT ${DEMO_MARKET_ID}`;

      const [{ count }] = await sql`SELECT count(*)::int AS count FROM accounts`;
      if (count === 0) {
        const demo = demoAccount(hashPassword(DEMO_PASSWORD));
        await insertAccount(sql, demo);
        const [{ count: boothCount }] =
          await sql`SELECT count(*)::int AS count FROM booths WHERE market_id = ${DEMO_MARKET_ID}`;
        if (boothCount === 0) {
          for (const b of defaultBooths(DEMO_MARKET_ID, "demo")) await insertBooth(sql, b);
          for (const bk of demoBookings()) {
            await sql`INSERT INTO bookings (id, booth_id, market_id, status, total_price, message,
                vendor_name, business_name, email, phone, category)
              VALUES (${bk.id}, ${bk.boothId}, ${bk.marketId}, ${bk.status}, ${bk.totalPrice}, ${bk.message},
                ${bk.vendor.name}, ${bk.vendor.businessName}, ${bk.vendor.email}, ${bk.vendor.phone}, ${bk.vendor.category})`;
            for (const date of bk.dates) {
              await sql`INSERT INTO booking_dates (booking_id, date) VALUES (${bk.id}, ${date})`;
            }
          }
        }
      }
    })().catch((err) => {
      ready = null; // allow retry on next request
      throw err;
    });
  }
  return ready;
}

async function db(): Promise<Sql> {
  const sql = client();
  await init(sql);
  return sql;
}

/* ── Row mappers ─────────────────────────────────────────── */

interface AccountRow {
  id: string; email: string; password_hash: string; owner_name: string; market_name: string;
  slug: string; plan: string; license_key: string; license_status: string;
  trial_ends_at: Date; created_at: Date;
}
interface BoothRow {
  id: string; market_id: string; label: string; zone: string; x: number; y: number;
  w: number; h: number; price_per_day: string; active: boolean;
}
interface BookingRow {
  id: string; booth_id: string; market_id: string; status: string; total_price: string;
  message: string; created_at: Date; vendor_name: string; business_name: string;
  email: string; phone: string; category: string; dates: string[] | null;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id, email: r.email, passwordHash: r.password_hash, ownerName: r.owner_name,
    marketName: r.market_name, slug: r.slug, plan: r.plan as Account["plan"],
    licenseKey: r.license_key, licenseStatus: r.license_status as Account["licenseStatus"],
    trialEndsAt: new Date(r.trial_ends_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function toBooth(r: BoothRow): Booth {
  return {
    id: r.id, marketId: r.market_id, label: r.label, zone: r.zone, x: r.x, y: r.y,
    w: r.w, h: r.h, pricePerDay: Number(r.price_per_day), active: r.active,
  };
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    boothId: r.booth_id,
    marketId: r.market_id,
    status: r.status as Booking["status"],
    dates: (r.dates ?? []).map((d) => String(d).slice(0, 10)).sort(),
    totalPrice: Number(r.total_price),
    message: r.message,
    createdAt: new Date(r.created_at).toISOString(),
    vendor: {
      id: r.id, name: r.vendor_name, businessName: r.business_name,
      email: r.email, phone: r.phone, category: r.category,
    },
  };
}

async function insertAccount(sql: Sql, a: Account): Promise<void> {
  await sql`INSERT INTO accounts (id, email, password_hash, owner_name, market_name, slug,
      plan, license_key, license_status, trial_ends_at, created_at)
    VALUES (${a.id}, ${a.email}, ${a.passwordHash}, ${a.ownerName}, ${a.marketName}, ${a.slug},
      ${a.plan}, ${a.licenseKey}, ${a.licenseStatus}, ${a.trialEndsAt}, ${a.createdAt})`;
}

async function insertBooth(sql: Sql, b: Booth): Promise<void> {
  await sql`INSERT INTO booths (id, market_id, label, zone, x, y, w, h, price_per_day, active)
    VALUES (${b.id}, ${b.marketId}, ${b.label}, ${b.zone}, ${b.x}, ${b.y}, ${b.w}, ${b.h},
      ${b.pricePerDay}, ${b.active})`;
}

const BOOKING_SELECT = `
  SELECT b.*, (
    SELECT array_agg(d.date::text ORDER BY d.date) FROM booking_dates d WHERE d.booking_id = b.id
  ) AS dates FROM bookings b`;

export class PgStore implements Store {
  /* ── Accounts ────────────────────────────────────────── */

  async createAccount(account: Account): Promise<Account> {
    const sql = await db();
    await insertAccount(sql, account);
    return account;
  }

  async getAccountByEmail(email: string): Promise<Account | null> {
    const sql = await db();
    const rows = await sql<AccountRow[]>`SELECT * FROM accounts WHERE email = ${email.toLowerCase()}`;
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    const sql = await db();
    const rows = await sql<AccountRow[]>`SELECT * FROM accounts WHERE id = ${id}`;
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async getAccountBySlug(slug: string): Promise<Account | null> {
    const sql = await db();
    const rows = await sql<AccountRow[]>`SELECT * FROM accounts WHERE slug = ${slug}`;
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async slugExists(slug: string): Promise<boolean> {
    const sql = await db();
    const rows = await sql`SELECT 1 FROM accounts WHERE slug = ${slug}`;
    return rows.length > 0;
  }

  async seedMarket(marketId: string): Promise<void> {
    const sql = await db();
    for (const b of defaultBooths(marketId, marketId.slice(0, 8))) await insertBooth(sql, b);
  }

  /* ── Booths & bookings ───────────────────────────────── */

  async getBooth(marketId: string, id: string): Promise<Booth | null> {
    const sql = await db();
    const rows = await sql<BoothRow[]>`
      SELECT * FROM booths WHERE market_id = ${marketId} AND id = ${id} AND active`;
    return rows[0] ? toBooth(rows[0]) : null;
  }

  async boothsWithAvailability(marketId: string, dates: string[], admin: boolean): Promise<BoothWithAvailability[]> {
    const sql = await db();
    const booths = await sql<BoothRow[]>`
      SELECT * FROM booths WHERE market_id = ${marketId} AND active ORDER BY label`;
    const approved = dates.length
      ? await sql<{
          booth_id: string; date: string; business_name: string; vendor_name: string;
          category: string; id: string;
        }[]>`
        SELECT b.booth_id, d.date::text AS date, b.business_name, b.vendor_name, b.category, b.id
        FROM bookings b JOIN booking_dates d ON d.booking_id = b.id
        WHERE b.market_id = ${marketId} AND b.status = 'approved' AND d.date IN ${sql(dates)}`
      : [];
    return booths.map((row) => {
      const booth = toBooth(row);
      const own = approved
        .filter((a) => a.booth_id === booth.id)
        .map((a) => ({
          date: String(a.date).slice(0, 10), businessName: a.business_name,
          vendorName: a.vendor_name, category: a.category, bookingId: a.id,
        }));
      return decorateBooth(booth, own, dates, admin);
    });
  }

  async createInquiry(marketId: string, input: InquiryInput, totalPrice: number): Promise<Booking> {
    const sql = await db();
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO bookings (id, booth_id, market_id, status, total_price, message,
          vendor_name, business_name, email, phone, category)
        VALUES (${id}, ${input.boothId}, ${marketId}, 'pending', ${totalPrice}, ${input.message ?? ""},
          ${input.name}, ${input.businessName}, ${input.email}, ${input.phone}, ${input.category})`;
      for (const date of input.dates) {
        await tx`INSERT INTO booking_dates (booking_id, date) VALUES (${id}, ${date})`;
      }
    });
    return (await this.getBooking(marketId, id))!;
  }

  async listBookings(marketId: string): Promise<Booking[]> {
    const sql = await db();
    const rows = await sql.unsafe<BookingRow[]>(
      `${BOOKING_SELECT} WHERE b.market_id = $1 ORDER BY b.created_at DESC`, [marketId]);
    return rows.map(toBooking);
  }

  async getBooking(marketId: string, id: string): Promise<Booking | null> {
    const sql = await db();
    const rows = await sql.unsafe<BookingRow[]>(
      `${BOOKING_SELECT} WHERE b.market_id = $1 AND b.id = $2`, [marketId, id]);
    return rows[0] ? toBooking(rows[0]) : null;
  }

  async approveBooking(marketId: string, id: string): Promise<ApproveResult> {
    const sql = await db();
    return sql.begin(async (tx): Promise<ApproveResult> => {
      const target = await tx.unsafe<BookingRow[]>(
        `${BOOKING_SELECT} WHERE b.market_id = $1 AND b.id = $2 FOR UPDATE OF b`, [marketId, id]);
      if (!target[0]) return { ok: false, conflicts: [] };
      const booking = toBooking(target[0]);
      if (booking.status !== "pending" && booking.status !== "approved") return { ok: false, conflicts: [] };
      if (booking.status === "approved") return { ok: true, booking, alreadyApproved: true };
      // Different applications have different booking rows. Lock their shared
      // booth before checking availability so competing approvals serialize.
      // The next statement then sees the preceding approval's committed dates.
      const booth = await tx`SELECT id FROM booths
        WHERE id = ${booking.boothId} AND market_id = ${marketId} AND active
        FOR UPDATE`;
      if (!booth.length) return { ok: false, conflicts: [] };
      const conflicts = await tx<{ date: string; business_name: string }[]>`
        SELECT d.date::text AS date, b.business_name
        FROM bookings b JOIN booking_dates d ON d.booking_id = b.id
        WHERE b.market_id = ${marketId} AND b.booth_id = ${booking.boothId}
          AND b.status = 'approved' AND b.id != ${id}
          AND d.date IN ${tx(booking.dates)}`;
      if (conflicts.length > 0) {
        return {
          ok: false,
          conflicts: conflicts.map((c) => ({
            date: String(c.date).slice(0, 10), businessName: c.business_name,
          })),
        };
      }
      await tx`UPDATE bookings SET status = 'approved' WHERE id = ${id}`;
      booking.status = "approved";
      return { ok: true, booking };
    });
  }

  async setBookingStatus(marketId: string, id: string, status: "rejected" | "cancelled"): Promise<Booking | null> {
    const sql = await db();
    await sql`UPDATE bookings SET status = ${status} WHERE market_id = ${marketId} AND id = ${id}`;
    return this.getBooking(marketId, id);
  }

  async updateBooth(marketId: string, id: string, patch: Partial<Booth>): Promise<Booth | null> {
    const sql = await db();
    const current = await this.getBooth(marketId, id);
    if (!current) return null;
    const next = { ...current, ...patch, id, marketId };
    await sql`UPDATE booths SET label = ${next.label}, zone = ${next.zone},
      x = ${Math.round(next.x)}, y = ${Math.round(next.y)},
      w = ${Math.round(next.w)}, h = ${Math.round(next.h)},
      price_per_day = ${next.pricePerDay}, active = ${next.active}
      WHERE market_id = ${marketId} AND id = ${id}`;
    return next;
  }

  async createBooth(booth: Booth): Promise<Booth> {
    const sql = await db();
    await insertBooth(sql, booth);
    return booth;
  }

  async deleteBooth(marketId: string, id: string): Promise<boolean> {
    const sql = await db();
    const rows = await sql`
      UPDATE booths SET active = FALSE WHERE market_id = ${marketId} AND id = ${id} RETURNING id`;
    return rows.length > 0;
  }
}
