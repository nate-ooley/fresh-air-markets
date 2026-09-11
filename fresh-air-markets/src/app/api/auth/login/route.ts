import { readObjectBody } from "@/lib/request-body";
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { makeSessionToken, makeStaffSessionToken, SESSION_COOKIE, sessionCookieOptions, verifyPassword } from "@/lib/auth";
import { DEMO_MARKET_ID } from "@/lib/seed";
import { demoTenantAllowed } from "@/lib/demo-tenant";
import { toPublicAccount } from "@/lib/types";

export const dynamic = "force-dynamic";
const UNAVAILABLE = { error: "Sign-in is temporarily unavailable. Please try again shortly." };
const INVALID = { error: "Invalid email or password." };

/**
 * Staff sign-in. With a database, the person is looked up in the staff table
 * and gets a session naming both the market and themselves. A market that has
 * no staff rows yet (or the in-memory demo) still signs in with its account
 * login and is carried over as the owner.
 */
export async function POST(req: NextRequest) {
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  let store, account, login;
  try {
    store = await getStore();
    if (process.env.DATABASE_URL) {
      const { findStaffLogin } = await import("@/lib/staff-users");
      login = await findStaffLogin(email);
    }
  } catch {
    return NextResponse.json(UNAVAILABLE, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
  }

  if (login?.kind === "ambiguous") return NextResponse.json({ error: "This email is attached to more than one market. Contact the site administrator." }, { status: 409 });
  if (login?.kind === "invited") return NextResponse.json({ error: "Finish setting up your account from your invitation email first." }, { status: 401 });

  let token: string;
  try {
    if (login?.kind === "found") {
      if (!verifyPassword(password, login.passwordHash)) return NextResponse.json(INVALID, { status: 401 });
      account = await store.getAccountById(login.user.marketId);
      if (!account) return NextResponse.json(INVALID, { status: 401 });
      token = makeStaffSessionToken(login.user.marketId, login.user.id);
    } else {
      account = await store.getAccountByEmail(email);
      if (!account || !verifyPassword(password, account.passwordHash)
        || (account.id === DEMO_MARKET_ID && !demoTenantAllowed())) {
        return NextResponse.json(INVALID, { status: 401 });
      }
      let staffToken: string | null = null;
      if (process.env.DATABASE_URL) {
        // First sign-in after the staff table arrived: carry the login over as owner.
        try {
          const { ensureOwnerStaff } = await import("@/lib/staff-users");
          const owner = await ensureOwnerStaff(account);
          if (owner) staffToken = makeStaffSessionToken(account.id, owner.id);
        } catch { staffToken = null; }
      }
      token = staffToken ?? makeSessionToken(account.id);
    }
  } catch (error) {
    if (error instanceof Error && /storage|unavailable/i.test(error.message)) {
      return NextResponse.json(UNAVAILABLE, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
    }
    // AUTH_SECRET is missing or weak; never issue a cookie signed with a fallback.
    return NextResponse.json(UNAVAILABLE, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
  const res = NextResponse.json({ account: toPublicAccount(account), staff: login?.kind === "found" ? { id: login.user.id, name: login.user.name, role: login.user.role } : null });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
