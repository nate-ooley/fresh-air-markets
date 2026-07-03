import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { makeSessionToken, SESSION_COOKIE, sessionCookieOptions, verifyPassword } from "@/lib/auth";
import { toPublicAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  const store = await getStore();
  const account = await store.getAccountByEmail(email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const res = NextResponse.json({ account: toPublicAccount(account) });
  res.cookies.set(SESSION_COOKIE, makeSessionToken(account.id), sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
