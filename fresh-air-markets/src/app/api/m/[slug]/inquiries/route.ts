import { readInquiryBody } from "@/lib/inquiry-body";
import { consumeInquiryLimit, inquiryClient } from "@/lib/inquiry-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { marketBookableDates } from "@/lib/market-calendar";
import { syncBookingToGhl } from "@/lib/ghl";
import { VENDOR_CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function enforceLimit(kind: "ip" | "email", subject: string) {
  try {
    const decision = await consumeInquiryLimit(kind, subject);
    if (decision.allowed) return null;
    return NextResponse.json({ error: "Too many applications. Please wait and try again." }, {
      status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  } catch {
    // A broken/missing shared limiter must not silently permit unbounded CRM sends.
    return NextResponse.json({ error: "Applications are temporarily unavailable. Please try again shortly." }, {
      status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }
}

/** Public: a vendor asks to rent a booth at this market. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const limited = await enforceLimit("ip", inquiryClient(req.headers));
  if (limited) return limited;
  const { slug } = await params;
  const store = await getStore();
  const account = await store.getAccountBySlug(slug);
  if (!account) return NextResponse.json({ error: "Market not found." }, { status: 404 });

  const parsed = await readInquiryBody(req);
  if ("status" in parsed) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { body } = parsed;

  // Validate types before normalization: String(array/object) can otherwise turn
  // malformed input into a seemingly valid vendor name, email or booth ID.
  const textLimits: Record<string, number> = {
    name: 200, businessName: 200, email: 254, phone: 40,
    category: 100, boothId: 200, message: 2000,
  };
  for (const [field, limit] of Object.entries(textLimits)) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length > limit)) {
      return NextResponse.json({ error: `${field} must be text of at most ${limit} characters.` }, { status: 400 });
    }
  }
  const valid = marketBookableDates(account.id);
  if (!Array.isArray(body.dates) || body.dates.length > valid.size ||
      body.dates.some((date) => typeof date !== "string" || !valid.has(date))) {
    return NextResponse.json({ error: "Select valid open market days." }, { status: 400 });
  }

  const errors: string[] = [];
  const name = String(body.name ?? "").trim();
  const businessName = String(body.businessName ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").trim();
  const category = String(body.category ?? "").trim();
  const boothId = String(body.boothId ?? "").trim();
  const message = String(body.message ?? "").trim().slice(0, 2000);
  const dates = Array.isArray(body.dates) ? [...new Set(body.dates.map(String))] : [];

  if (!name) errors.push("Your name is required.");
  if (!businessName) errors.push("Business name is required.");
  if (!EMAIL_RE.test(email)) errors.push("A valid email is required.");
  if (!category || !(VENDOR_CATEGORIES as readonly string[]).includes(category))
    errors.push("Please pick a vendor category.");
  if (dates.length === 0) errors.push("Select at least one market day.");

  if (dates.some((d) => !valid.has(d))) errors.push("One or more selected dates are not open market days.");

  const booth = boothId ? await store.getBooth(account.id, boothId) : null;
  if (!booth) errors.push("That booth doesn't exist.");

  if (errors.length > 0 || !booth) {
    return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
  }

  const emailLimited = await enforceLimit("email", JSON.stringify([account.id, email]));
  if (emailLimited) return emailLimited;

  // A booth can only hold one vendor per day: block dates already approved.
  const [availability] = (await store.boothsWithAvailability(account.id, dates, false)).filter(
    (b) => b.id === booth.id,
  );
  const taken = availability?.bookedDates ?? [];
  if (taken.length > 0) {
    return NextResponse.json(
      { error: `Booth ${booth.label} is already rented on: ${taken.join(", ")}. Pick different dates.` },
      { status: 409 },
    );
  }

  const totalPrice = booth.pricePerDay * dates.length;
  const booking = await store.createInquiry(
    account.id,
    { boothId: booth.id, name, businessName, email, phone, category, dates: dates.sort(), message },
    totalPrice,
  );

  // Sync to GoHighLevel so marketing/communication automations fire.
  const ghlSynced = await syncBookingToGhl(booking, "booth-inquiry", booth.label);

  return NextResponse.json({ booking, totalPrice, ghlSynced }, { status: 201 });
}
