const { demoAccount, defaultBooths, demoBookings, DEMO_MARKET_ID, DEMO_PASSWORD } = require('../.test-build/seed.js');
const { hashPassword } = require('../.test-build/auth.js');
const { upcomingWeekends } = require('../.test-build/dates.js');

/** Use the actual portal seed, not the recognizer's private fixture constants. */
function seededRows(from) {
  const a = demoAccount(hashPassword(DEMO_PASSWORD));
  const bookings = demoBookings();
  if (from) {
    const weekends = upcomingWeekends(new Date(from), 2).map(w => w.dates.map(d => d.date));
    for (const b of bookings) {
      b.createdAt = from;
      b.dates = b.id === 'demo-2' ? weekends.flat() : weekends[b.id === 'demo-4' ? 1 : 0];
      b.totalPrice = ({ 'demo-1': 55, 'demo-2': 60, 'demo-3': 55, 'demo-4': 65 })[b.id] * b.dates.length;
    }
  }
  return {
    accounts: [{ id: a.id, email: a.email, password_hash: a.passwordHash, owner_name: a.ownerName,
      market_name: a.marketName, slug: a.slug, plan: a.plan, license_key: a.licenseKey,
      license_status: a.licenseStatus, trial_ends_at: a.trialEndsAt, created_at: a.createdAt }],
    booths: defaultBooths(DEMO_MARKET_ID, 'demo').map(b => ({ id: b.id, market_id: b.marketId, label: b.label,
      zone: b.zone, x: b.x, y: b.y, w: b.w, h: b.h, price_per_day: b.pricePerDay, active: b.active })),
    bookings: bookings.map(b => ({ id: b.id, booth_id: b.boothId, market_id: b.marketId, status: b.status,
      total_price: b.totalPrice, message: b.message, created_at: b.createdAt, vendor_name: b.vendor.name,
      business_name: b.vendor.businessName, email: b.vendor.email, phone: b.vendor.phone, category: b.vendor.category })),
    dates: bookings.flatMap(b => b.dates.map(date => ({ booking_id: b.id, date }))), inquiryCount: 0,
  };
}

module.exports = { seededRows };
