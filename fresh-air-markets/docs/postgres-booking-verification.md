# PostgreSQL booking verification

The separate `tests/pg/booking-store.test.cjs` suite runs the real `PgStore` and its full schema initializer in `qa_booking_store`, a temporary schema inside the local disposable `fresh_air_test` database. It refuses remote/non-test database URLs. No HighLevel, email, Square or production database calls occur.

Five scenarios cover:

1. Twenty pending applications compete for one booth/date over two connection pools. Exactly one approval wins and nineteen return conflicts. Twenty concurrent repeats of the winner return its existing approval without another transition. Public availability omits occupants.
2. A two-date request conflicts on one date: it remains pending and the other date stays available. Cancellation releases capacity; the other request then approves. Cancelled/rejected requests cannot be revived by late approval.
3. A different market cannot read, approve, cancel, edit or create an inquiry against an owned booth. Failed cross-market capture leaves zero foreign-market bookings.
4. A bad second date fails after the booking and first date were inserted. The whole transaction rolls back with no orphan date, then a corrected request succeeds.
5. A new connection pool sees the committed approval and dates. Approval replay is recognized, and an inactive booth cannot be approved or receive a new inquiry.

## Defect and repair

The first real schema initialization failed with PostgreSQL `42P18` because the legacy-column DDL used a protocol parameter for its default. The initializer now builds that DDL literal from the internal escaped demo-market constant, never request input. Initialization promises are tracked per connection pool, permitting independent pool checks and retry after an initialization failure.

Inquiry creation also checks market ownership and active state inside its transaction with a shared row lock. This preserves those checks until commit, including changes after the route's earlier availability lookup.

## Limits

These tests exercise the existing one-booth booking store. They do not establish the full Fresh Air final-quantity/category-capacity CHECK/RESERVE flow, eligibility, quote revisions, payment holds or expiry. Reconnecting a client is not a database-server restart or disaster-recovery test. Fresh-schema initialization passes; migration against a copy of the actual production schema and historical data is still required. The draft PR is not deployed.

Postgres.js connection, transaction and pool behavior: https://github.com/porsager/postgres#connection-details
