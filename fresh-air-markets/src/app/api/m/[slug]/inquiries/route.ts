import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { bookableDates } from "@/lib/dates";
import { syncBookingToGhl } from "@/lib/ghl";
import { InquiryInput, VENDOR_CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public: a vendor asks to rent a booth at this market. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await getStore();
  const account = await store.getAccountBySlug(slug);
  if (!account) return NextResponse.json({ error: "Market not found." }, { status: 404 });

  let body: Partial<InquiryInput>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
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

  const valid = bookableDates();
  if (dates.some((d) => !valid.has(d))) errors.push("One or more selected dates are not open market days.");

  const booth = boothId ? await store.getBooth(account.id, boothId) : null;
  if (!booth) errors.push("That booth doesn't exist.");

  if (errors.length > 0 || !booth) {
    return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
  }

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
