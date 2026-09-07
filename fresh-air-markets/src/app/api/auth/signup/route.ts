import { readObjectBody } from "@/lib/request-body";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStore, slugify } from "@/lib/store";
import { hashPassword, makeSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { generateLicenseKey, isPlan, trialEndsAt } from "@/lib/plans";
import { Account, toPublicAccount } from "@/lib/types";
import { syncOperatorToGhl } from "@/lib/ghl";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create a Fresh Air account: license + seeded market + session, in one step. */
export async function POST(req: NextRequest) {
  const body = await readObjectBody(req);
  if (!body) return NextResponse.json({ error: "A JSON object body is required." }, { status: 400 });
  const ownerName = String(body.ownerName ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const marketName = String(body.marketName ?? "").trim();
  const plan = String(body.plan ?? "starter");

  const errors: string[] = [];
  if (!ownerName) errors.push("Your name is required.");
  if (!EMAIL_RE.test(email)) errors.push("A valid email is required.");
  if (password.length < 8) errors.push("Password must be at least 8 characters.");
  if (!marketName) errors.push("Your market's name is required.");
  if (!isPlan(plan)) errors.push("Pick a valid plan.");
  if (errors.length || !isPlan(plan)) {
    return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
  }

  const store = await getStore();
  if (await store.getAccountByEmail(email)) {
    return NextResponse.json({ error: "An account with that email already exists — try logging in." }, { status: 409 });
  }

  // Unique public slug for the market's vendor-facing page.
  const base = slugify(marketName);
  let slug = base;
  for (let i = 2; await store.slugExists(slug); i++) slug = `${base}-${i}`;

  const account: Account = {
    id: randomUUID(),
    email,
    passwordHash: hashPassword(password),
    ownerName,
    marketName,
    slug,
    plan,
    licenseKey: generateLicenseKey(),
    licenseStatus: "trial",
    trialEndsAt: trialEndsAt(),
    createdAt: new Date().toISOString(),
  };
  await store.createAccount(account);
  await store.seedMarket(account.id);

  // Feed the sales/onboarding pipeline in GoHighLevel.
  await syncOperatorToGhl(account);

  const res = NextResponse.json({ account: toPublicAccount(account) }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, makeSessionToken(account.id), sessionCookieOptions());
  return res;
}

