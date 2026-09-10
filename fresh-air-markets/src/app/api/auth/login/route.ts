import { readObjectBody } from "@/lib/request-body";
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { makeSessionToken, SESSION_COOKIE, sessionCookieOptions, verifyPassword } from "@/lib/auth";
import { DEMO_MARKET_ID } from "@/lib/seed";
import { demoTenantAllowed } from "@/lib/demo-tenant";
import { toPublicAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  let account;
  try {
    const store = await getStore();
    account = await store.getAccountByEmail(email);
  } catch {
    return NextResponse.json({ error: "Sign-in is temporarily unavailable. Please try again shortly." },
      { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
  }
  if (!account || !verifyPassword(password, account.passwordHash)
    || (account.id === DEMO_MARKET_ID && !demoTenantAllowed())) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  let token: string;
  try {
    token = makeSessionToken(account.id);
  } catch {
    // AUTH_SECRET is missing or weak; never issue a cookie signed with a fallback.
    return NextResponse.json({ error: "Sign-in is temporarily unavailable. Please try again shortly." },
      { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
  const res = NextResponse.json({ account: toPublicAccount(account) });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
