import { Account, Booking } from "./types";
import { prettyDate } from "./dates";

/**
 * GoHighLevel (LeadConnector API v2) integration.
 *
 * Every booking lifecycle event upserts the vendor as a GHL contact and
 * applies a tag so GHL workflows can drive email/SMS automation:
 *
 *   booth-inquiry   -> new inquiry submitted (send confirmation / nurture)
 *   booth-approved  -> admin approved (send invoice, load-in instructions)
 *   booth-rejected  -> admin rejected (send waitlist / alternatives)
 *
 * Configure with GHL_API_TOKEN (Private Integration token) and
 * GHL_LOCATION_ID. When unset, calls are skipped and logged — the app
 * works fine without GHL connected.
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const FRESH_AIR_LOCATION_ID = "aooAnUXF0COePorBo7wL";

export type GhlEvent = "booth-inquiry" | "booth-approved" | "booth-rejected";

// Fresh Air uses exact-identity workflow adapters, never legacy contact upserts
// or lifecycle tags. Guard the deployment rather than a caller-supplied account
// so demo/other-market paths cannot borrow the dedicated integration token.
function legacySyncDisabled(): boolean {
  return process.env.GHL_LOCATION_ID?.trim() === FRESH_AIR_LOCATION_ID
    || process.env.FAME_MARKET_ACCOUNT_ID !== undefined;
}

function configured(): boolean {
  return Boolean(process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID);
}

async function ghlFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${GHL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * SaaS lifecycle: sync a market operator (Fresh Air customer) to GHL so
 * onboarding and license-sales automations fire. Tags:
 *   bhq-signup, bhq-plan-<starter|pro|season>
 */
export async function syncOperatorToGhl(account: Account): Promise<boolean> {
  if (legacySyncDisabled()) return false;
  if (!configured()) {
    console.log(`[ghl] not configured — skipped operator signup for ${account.email}`);
    return false;
  }
  try {
    const [firstName, ...rest] = account.ownerName.trim().split(/\s+/);
    const res = await ghlFetch("/contacts/upsert", {
      locationId: process.env.GHL_LOCATION_ID,
      email: account.email,
      firstName,
      lastName: rest.join(" ") || undefined,
      companyName: account.marketName,
      source: "Fresh Air Signup",
      tags: ["bhq-signup", `bhq-plan-${account.plan}`],
    });
    if (!res.ok) {
      console.error(`[ghl] operator upsert failed (${res.status}): ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[ghl] operator sync error:", err);
    return false;
  }
}

/**
 * Fire-and-forget sync: never throws, never blocks the booking flow.
 * Returns true if the contact was synced to GHL.
 */
export async function syncBookingToGhl(
  booking: Booking,
  event: GhlEvent,
  boothLabel: string,
): Promise<boolean> {
  if (legacySyncDisabled()) return false;
  if (!configured()) {
    console.log(`[ghl] not configured — skipped '${event}' for ${booking.vendor.email}`);
    return false;
  }
  try {
    const [firstName, ...rest] = booking.vendor.name.trim().split(/\s+/);
    const dates = booking.dates.map(prettyDate).join(", ");

    const upsert = await ghlFetch("/contacts/upsert", {
      locationId: process.env.GHL_LOCATION_ID,
      email: booking.vendor.email,
      phone: booking.vendor.phone || undefined,
      firstName,
      lastName: rest.join(" ") || undefined,
      companyName: booking.vendor.businessName,
      source: "Farmers Market Booth App",
      tags: [event, `category-${booking.vendor.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`],
    });
    if (!upsert.ok) {
      console.error(`[ghl] upsert failed (${upsert.status}): ${await upsert.text()}`);
      return false;
    }
    const { contact } = (await upsert.json()) as { contact?: { id?: string } };

    // Leave a note on the contact so the team sees full booking context in GHL.
    if (contact?.id) {
      const note = await ghlFetch(`/contacts/${contact.id}/notes`, {
        body:
          `${event.replace("booth-", "").toUpperCase()}: Booth ${boothLabel} — ${dates}. ` +
          `Total $${booking.totalPrice}. ${booking.message ? `Message: ${booking.message}` : ""}`.trim(),
      });
      if (!note.ok) console.error(`[ghl] note failed (${note.status})`);
    }
    return true;
  } catch (err) {
    console.error("[ghl] sync error:", err);
    return false;
  }
}
