import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { DatabaseReadinessError, resolveQaTarget } from './database-readiness.mjs';

// Keep these four statements identical to PgStore's base tables. The parity
// test prevents schema drift without importing its demo-seeding initializer.
export const BASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
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
  )`,
  `CREATE TABLE IF NOT EXISTS booths (
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
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
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
  )`,
  `CREATE TABLE IF NOT EXISTS booking_dates (
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    PRIMARY KEY (booking_id, date)
  )`,
];
const QA_EMAILS = new Set(['nate@autocraftstudios.com', 'lnooley@gmail.com']);
const PURPOSE = 'fresh-air-qa-bootstrap-v1';
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9:_-]{1,192}$/;
const HASH = /^[a-f0-9]{32}:[a-f0-9]{64}$/;
const UUID = /^qa-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = code => { throw new DatabaseReadinessError(code); };
const INSPECTIONS = new Set(['inspect', 'inspect-seeded-qa']);
const CREATIONS = new Set(['create', 'add-to-seeded-qa']);

// Recognition only: never import/call the portal's demo initializer here. Tests
// compare these identities against its actual fixtures to catch seed drift.
const DEMO = { id: 'demo-market', email: 'demo@freshairmarkets.app', owner_name: 'Demo Operator',
  market_name: 'Sunrise Farmers Market', slug: 'sunrise-market', plan: 'pro',
  license_key: 'FAM-DEMO-DEMO-DEMO', license_status: 'active' };
const DEMO_BOOKINGS = [
  ['demo-1', 'demo-a1', 'approved', 'Rosa Alvarez', 'Sunrise Farms', 'rosa@sunrisefarms.example', 'Produce', 55, 'first'],
  ['demo-2', 'demo-d3', 'approved', 'Marcus Lee', 'Golden Crust Bakery', 'marcus@goldencrust.example', 'Baked Goods', 60, 'both'],
  ['demo-3', 'demo-b4', 'approved', 'Priya Patel', 'Bloom & Stem', 'priya@bloomstem.example', 'Flowers & Plants', 55, 'first'],
  ['demo-4', 'demo-b1', 'pending', 'Jake Thompson', "Smoky J's BBQ", 'jake@smokyjs.example', 'Prepared Food', 65, 'second'],
].map(([id, booth_id, status, vendor_name, business_name, email, category, dailyPrice, weekend]) =>
  ({ id, booth_id, status, vendor_name, business_name, email, category, dailyPrice, weekend,
    market_id: DEMO.id, phone: '555-0100', message: '' }));
const SEEDED_COLUMNS = {
  accounts: 'id:text email:text password_hash:text owner_name:text market_name:text slug:text plan:text license_key:text license_status:text trial_ends_at:timestamptz created_at:timestamptz',
  booths: 'id:text market_id:text label:text zone:text x:int4 y:int4 w:int4 h:int4 price_per_day:numeric active:bool',
  bookings: 'id:text booth_id:text market_id:text status:text total_price:numeric message:text created_at:timestamptz vendor_name:text business_name:text email:text phone:text category:text',
  booking_dates: 'booking_id:text date:date',
  inquiry_requests: 'market_id:text request_key:text payload_hash:text booking_id:text created_at:timestamptz',
};
const SEEDED_CONSTRAINTS = {
  accounts: ['p:id', 'u:email', 'u:slug'], booths: ['p:id'],
  bookings: ['p:id', 'f:booth_id:booths:id:a'],
  booking_dates: ['p:booking_id,date', 'f:booking_id:bookings:id:c'],
  inquiry_requests: ['p:market_id,request_key', 'f:booking_id:bookings:id:a'],
};

export function parseOptions(args) {
  const command = args[0];
  if (!INSPECTIONS.has(command) && !CREATIONS.has(command) && command !== 'verify-existing') fail('qa_bootstrap_usage');
  const options = { command };
  const allowed = new Set(['expected-host', 'email', 'account-id', 'slug', 'qa-capacity', 'credentials-file']);
  for (const arg of args.slice(1)) {
    if (arg === '--qa' && !options.qa) { options.qa = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !allowed.has(match[1]) || options[match[1]] !== undefined) fail('qa_bootstrap_usage');
    options[match[1]] = match[2];
  }
  if (INSPECTIONS.has(command) && ['email', 'account-id', 'slug', 'qa-capacity', 'credentials-file'].some(key => options[key])) fail('qa_bootstrap_usage');
  if (!INSPECTIONS.has(command) && (!QA_EMAILS.has(options.email) || !/^[1-9]\d{0,3}$/.test(options['qa-capacity'] ?? ''))) fail('qa_identity_or_capacity_invalid');
  if (CREATIONS.has(command) && (!/^qa-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.slug ?? '') || options.slug.length > 40
    || !path.isAbsolute(options['credentials-file'] ?? '') || options['account-id'])) fail('qa_bootstrap_usage');
  if (command === 'verify-existing' && (!ID.test(options['account-id'] ?? '') || options['account-id'] === 'demo-market'
    || options.slug || options['credentials-file'])) fail('qa_bootstrap_usage');
  return options;
}

export function validateConfig(env, options) {
  const target = resolveQaTarget(env, { qa: options.qa, expectedHost: options['expected-host'] });
  if (env.SQUARE_ENVIRONMENT !== 'sandbox' || env.SQUARE_ALLOW_LIVE_PAYMENTS !== 'false') fail('qa_sandbox_live_off_required');
  // Review and agreement delivery have no ENABLED flag: their Preview gate is
  // GHL_PAYMENT_QA_ROUTING_VERIFIED. Do not configure that gate during setup.
  if (Object.entries(env).some(([key, value]) => value !== undefined && value !== '' && value !== 'false'
    && (/^GHL_.*_ENABLED$/.test(key) || /^FAME_.*SCHEDULER_ENABLED$/.test(key) || key === 'GHL_PAYMENT_QA_ROUTING_VERIFIED'))
    || (env.GHL_PAYMENT_DELIVERY_MODE && env.GHL_PAYMENT_DELIVERY_MODE !== 'qa')) fail('qa_outbound_workers_must_be_disabled');
  if (env.GHL_LOCATION_ID && env.GHL_LOCATION_ID !== 'aooAnUXF0COePorBo7wL') fail('qa_location_mismatch');
  if (!INSPECTIONS.has(options.command)) {
    if (!env.AUTH_SECRET || env.AUTH_SECRET.trim().length < 32 || /[\r\n\0]/.test(env.AUTH_SECRET)) fail('qa_private_auth_secret_required');
    if (env.FAME_SEASON_ID !== '2026-2027') fail('qa_season_invalid');
    if (env.FAME_BOOTH_CAPACITY !== undefined && env.FAME_BOOTH_CAPACITY !== options['qa-capacity']) fail('qa_capacity_mapping_conflict');
    if (options.command === 'verify-existing' && env.FAME_MARKET_ACCOUNT_ID !== options['account-id']) fail('qa_account_mapping_conflict');
  }
  const url = new URL(target.url);
  const targetKey = createHash('sha256').update(JSON.stringify([url.hostname.replace(/-pooler(?=\.)/, ''), url.pathname, url.username])).digest('hex');
  return { ...target, targetKey };
}

export function hashQaPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function matchesPassword(password, stored) {
  if (!HASH.test(stored)) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(hash, 'hex'));
}

function newCredentials(options, target) {
  const createdAt = new Date().toISOString();
  return {
    purpose: PURPOSE, targetKey: target.targetKey, accountId: `qa-${randomUUID()}`,
    email: options.email, slug: options.slug, password: randomBytes(32).toString('base64url'),
    ownerName: 'Fresh Air QA', marketName: 'Fresh Air QA', plan: 'starter', licenseStatus: 'trial',
    licenseKey: `FAM-${Array.from({ length: 3 }, () => randomBytes(2).toString('hex').toUpperCase()).join('-')}`,
    createdAt, trialEndsAt: new Date(Date.parse(createdAt) + 14 * 86400_000).toISOString(),
  };
}

function validateCredentials(value, options, target) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.purpose !== PURPOSE || value.targetKey !== target.targetKey
    || !UUID.test(value.accountId ?? '') || value.email !== options.email || value.slug !== options.slug
    || !/^[A-Za-z0-9_-]{43}$/.test(value.password ?? '') || value.ownerName !== 'Fresh Air QA' || value.marketName !== 'Fresh Air QA'
    || value.plan !== 'starter' || value.licenseStatus !== 'trial' || !/^FAM-(?:[A-F0-9]{4}-){2}[A-F0-9]{4}$/.test(value.licenseKey ?? '')
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.trialEndsAt))
    || Date.parse(value.trialEndsAt) - Date.parse(value.createdAt) !== 14 * 86400_000) fail('qa_credentials_file_mismatch');
  return value;
}

export async function privateCredentialPath(filename) {
  if (!path.isAbsolute(filename)) fail('qa_credentials_path_unsafe');
  const directory = path.dirname(filename);
  const actual = await realpath(directory);
  const info = await lstat(directory);
  const checkout = await realpath(path.dirname(appDirectory.replace(/\/$/, '')));
  if (actual !== directory || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || info.uid !== process.getuid?.() || actual === checkout || actual.startsWith(checkout + path.sep)) fail('qa_credentials_path_unsafe');
  return filename;
}

/** Same private file is the retry identity; it is never overwritten or printed. */
export async function credentialFile(filename, options, target, { allowCreate = true } = {}) {
  await privateCredentialPath(filename);
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code !== 'ENOENT') fail('qa_credentials_path_unsafe');
    if (!allowCreate) return null;
    const value = newCredentials(options, target);
    try { file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { fail('qa_credentials_file_creation_failed'); }
    try {
      await file.writeFile(JSON.stringify(value) + '\n', 'utf8');
      await file.sync();
    } finally { await file.close(); }
    return value;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.nlink !== 1 || info.size > 8192) fail('qa_credentials_path_unsafe');
    let value;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { fail('qa_credentials_file_invalid'); }
    return validateCredentials(value, options, target);
  } finally { await file.close(); }
}

async function inventory(sql) {
  const rows = await sql`SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r','p','v','m','f','S')
    ORDER BY c.relname`;
  const routines = await sql`SELECT count(*)::int AS count FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;
  return { relations: rows, routineCount: routines[0].count };
}

export async function inspectQaDatabase(sql) {
  return sql.begin('READ ONLY', async tx => {
    const state = await inventory(tx);
    return { empty: state.relations.length === 0 && state.routineCount === 0,
      relationCount: state.relations.length, routineCount: state.routineCount };
  });
}

function demoBooth(id) {
  const match = /^demo-([a-e])([1-8])$/.exec(id ?? '');
  if (!match) return null;
  const [, row, number] = match, i = Number(number) - 1;
  const common = { id, market_id: DEMO.id, label: row.toUpperCase() + number, active: true };
  if ((row === 'a' || row === 'c') && i < 6) return { ...common, zone: row === 'a' ? 'West Row' : 'East Row',
    x: row === 'a' ? 70 : 1050, y: 120 + i * 88, w: 80, h: 72, price_per_day: i === 0 || i === 5 ? 55 : 45 };
  if (row === 'b') return { ...common, zone: 'Entrance Promenade', x: 200 + i * 110, y: 690,
    w: 92, h: 72, price_per_day: i === 0 || i === 7 ? 65 : 55 };
  if ((row === 'd' || row === 'e') && i < 5) return { ...common, zone: 'Center Island', x: 296 + i * 126,
    y: row === 'd' ? 250 : 330, w: 104, h: 76, price_per_day: 60 };
  return null;
}

// Dates in the old demo vary with its creation day, including partial weekends.
// Recognize that calculation, never a fixed count or today's calendar.
function demoWeekends(createdAt) {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) fail('qa_seed_data_not_recognized');
  const start = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()));
  const sinceFriday = (start.getUTCDay() - 5 + 7) % 7;
  const friday = new Date(start);
  friday.setUTCDate(start.getUTCDate() - (sinceFriday <= 2 ? sinceFriday : sinceFriday - 7));
  return [0, 1].map(week => [0, 1, 2].map(day => {
    const date = new Date(friday);
    date.setUTCDate(friday.getUTCDate() + week * 7 + day);
    return date;
  }).filter(date => date >= start).map(date => date.toISOString().slice(0, 10)));
}

/** Permit only unchanged known demo rows; all output is aggregate metadata. */
export function validateSeededRows({ accounts, booths, bookings, dates, inquiryCount }) {
  const account = accounts[0];
  if (accounts.length !== 1 || !account || Object.entries(DEMO).some(([key, value]) => account[key] !== value)
    || !matchesPassword('sunrise-demo', account.password_hash)
    || !Number.isFinite(new Date(account.created_at).getTime()) || !Number.isFinite(new Date(account.trial_ends_at).getTime())
    || inquiryCount !== 0) fail('qa_seed_data_not_recognized');
  const boothIds = new Set();
  for (const booth of booths) {
    const expected = demoBooth(booth.id);
    if (!expected || boothIds.has(booth.id) || Object.entries(expected).some(([key, value]) =>
      (key === 'price_per_day' ? Number(booth[key]) : booth[key]) !== value)) fail('qa_seed_data_not_recognized');
    boothIds.add(booth.id);
  }
  const bookingIds = new Set();
  for (const booking of bookings) {
    const expected = DEMO_BOOKINGS.find(row => row.id === booking.id);
    if (!expected || bookingIds.has(booking.id) || !boothIds.has(booking.booth_id)
      || Object.entries(expected).some(([key, value]) => !['dailyPrice', 'weekend'].includes(key) && booking[key] !== value)) fail('qa_seed_data_not_recognized');
    const weekends = demoWeekends(booking.created_at);
    const expectedDates = expected.weekend === 'both' ? weekends.flat() : weekends[expected.weekend === 'first' ? 0 : 1];
    const actualDates = dates.filter(row => row.booking_id === booking.id).map(row => row.date).sort();
    if (JSON.stringify(actualDates) !== JSON.stringify(expectedDates)
      || Number(booking.total_price) !== expected.dailyPrice * expectedDates.length) fail('qa_seed_data_not_recognized');
    bookingIds.add(booking.id);
  }
  if (dates.some(row => !bookingIds.has(row.booking_id))) fail('qa_seed_data_not_recognized');
  return { recognizedSeed: true, accountCount: accounts.length, boothCount: booths.length,
    bookingCount: bookings.length, bookingDateCount: dates.length, inquiryCount };
}

async function verifySeededColumns(tx, tables) {
  const columns = await tx`SELECT c.relname AS table_name, a.attname AS name, t.typname AS type,
      t.typnamespace = 'pg_catalog'::regnamespace AS builtin,
      a.attnotnull AS required, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`;
  for (const table of tables) {
    const actual = columns.filter(row => row.table_name === table);
    const expected = SEEDED_COLUMNS[table].split(' ').sort();
    if (actual.some(row => !row.builtin || !row.required || row.identity || row.generated)
      || JSON.stringify(actual.map(row => `${row.name}:${row.type}`).sort()) !== JSON.stringify(expected)) fail('qa_seed_schema_not_recognized');
  }
}

async function verifySeededSchema(tx) {
  const state = await inventory(tx);
  const tables = Object.keys(SEEDED_COLUMNS);
  if (state.routineCount || state.relations.length !== tables.length
    || state.relations.some(row => row.kind !== 'r' || !tables.includes(row.name))) fail('qa_seed_schema_not_recognized');
  await verifySeededColumns(tx, tables);
  const guards = await tx`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND (c.relrowsecurity OR c.relforcerowsecurity)) AS policies,
    (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND (NOT t.tgisinternal OR t.tgenabled NOT IN ('O','A'))) AS triggers,
    (SELECT count(*)::int FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()) AS rules,
    (SELECT count(*)::int FROM pg_inherits h JOIN pg_class c ON c.oid IN (h.inhrelid, h.inhparent)
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()) AS inheritance,
    (SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND (NOT i.indisvalid OR NOT i.indisready OR NOT EXISTS
        (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p','u')))) AS unexpected_indexes`;
  if (Object.values(guards[0]).some(value => value !== 0)) fail('qa_seed_schema_not_recognized');
  const constraints = await tx`SELECT c.relname AS table_name, k.contype AS kind, k.convalidated AS valid,
      k.condeferrable AS deferred, k.confupdtype AS update_action, k.confdeltype AS delete_action, k.confmatchtype AS match_type,
      array_to_string(ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY AS x(num,ord)
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.num ORDER BY x.ord), ',') AS columns,
      f.relname AS reference_table, fn.nspname = current_schema() AS same_schema,
      array_to_string(ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY AS x(num,ord)
        JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.num ORDER BY x.ord), ',') AS reference_columns
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class f ON f.oid = k.confrelid LEFT JOIN pg_namespace fn ON fn.oid = f.relnamespace
    WHERE n.nspname = current_schema()`;
  for (const table of tables) {
    const actual = constraints.filter(row => row.table_name === table);
    if (actual.some(row => !row.valid || row.deferred || (row.kind === 'f'
      && (!row.same_schema || row.update_action !== 'a' || row.match_type !== 's')))) fail('qa_seed_schema_not_recognized');
    const signatures = actual.map(row => row.kind === 'f'
      ? `f:${row.columns}:${row.reference_table}:${row.reference_columns}:${row.delete_action}` : `${row.kind}:${row.columns}`).sort();
    if (JSON.stringify(signatures) !== JSON.stringify([...SEEDED_CONSTRAINTS[table]].sort())) fail('qa_seed_schema_not_recognized');
  }
}

async function inspectSeededRows(tx) {
  await verifySeededSchema(tx);
  const accounts = await tx`SELECT * FROM accounts`;
  const booths = await tx`SELECT * FROM booths`;
  const bookings = await tx`SELECT * FROM bookings`;
  const dates = await tx`SELECT booking_id, date::text AS date FROM booking_dates`;
  const [{ count: inquiryCount }] = await tx`SELECT count(*)::int AS count FROM inquiry_requests`;
  return validateSeededRows({ accounts, booths, bookings, dates, inquiryCount });
}

export async function inspectSeededQaDatabase(sql) {
  return sql.begin('READ ONLY', inspectSeededRows);
}

function validateAccountRow(row, identity) {
  if (!row || row.id !== identity.accountId || row.id === 'demo-market' || row.email !== identity.email
    || !HASH.test(row.password_hash ?? '') || !row.market_name || !row.slug) fail('qa_existing_account_mismatch');
  if (identity.password && (row.slug !== identity.slug || row.owner_name !== identity.ownerName || row.market_name !== identity.marketName
    || row.plan !== identity.plan || row.license_status !== identity.licenseStatus || row.license_key !== identity.licenseKey
    || new Date(row.created_at).toISOString() !== identity.createdAt || new Date(row.trial_ends_at).toISOString() !== identity.trialEndsAt
    || !matchesPassword(identity.password, row.password_hash))) fail('qa_existing_account_mismatch');
}

async function verifyAccount(tx, identity) {
  const state = await inventory(tx);
  if (!['accounts','booths','bookings','booking_dates'].every(name => state.relations.some(r => r.name === name && r.kind === 'r'))) fail('qa_base_schema_missing');
  const rows = await tx`SELECT id,email,password_hash,owner_name,market_name,slug,plan,license_key,license_status,trial_ends_at,created_at
    FROM accounts WHERE id = ${identity.accountId}`;
  validateAccountRow(rows[0], identity);
  return { status: 'verified_existing', accountId: identity.accountId };
}

export async function verifyExistingQaAccount(sql, identity) {
  if (!ID.test(identity.accountId ?? '') || identity.accountId === 'demo-market' || !QA_EMAILS.has(identity.email)) fail('qa_identity_or_capacity_invalid');
  return sql.begin('READ ONLY', tx => verifyAccount(tx, identity));
}

async function insertPrivateQaAccount(tx, credentials) {
  const hash = hashQaPassword(credentials.password);
  await tx`INSERT INTO accounts (id,email,password_hash,owner_name,market_name,slug,plan,license_key,license_status,trial_ends_at,created_at)
    VALUES (${credentials.accountId},${credentials.email},${hash},${credentials.ownerName},${credentials.marketName},${credentials.slug},
      ${credentials.plan},${credentials.licenseKey},${credentials.licenseStatus},${credentials.trialEndsAt},${credentials.createdAt})`;
  await verifyAccount(tx, credentials);
  return { status: 'created', accountId: credentials.accountId };
}

/** Explicit insert-only path for the untouched legacy demo in an isolated QA DB. */
export async function addQaAccountToSeededDatabase(sql, credentials) {
  if (!UUID.test(credentials.accountId ?? '') || !QA_EMAILS.has(credentials.email)) fail('qa_identity_or_capacity_invalid');
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SELECT pg_advisory_xact_lock(1178684741, 1)`;
    const state = await inventory(tx);
    if (!state.relations.some(row => row.name === 'accounts' && row.kind === 'r')) fail('qa_seed_schema_not_recognized');
    await tx`LOCK TABLE ONLY accounts IN SHARE ROW EXCLUSIVE MODE`;
    // The verification-only retry may run after migrations, but even its first
    // SELECT must not invoke a shadow column type or a row-security policy.
    await verifySeededColumns(tx, ['accounts']);
    const lookup = await tx`SELECT c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules
      OR EXISTS (SELECT 1 FROM pg_inherits h WHERE c.oid IN (h.inhrelid, h.inhparent)) AS unsafe
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'accounts'`;
    if (lookup[0]?.unsafe !== false) fail('qa_seed_schema_not_recognized');
    const existing = await tx`SELECT id FROM accounts WHERE id = ${credentials.accountId}`;
    // A same-file retry is verification only, including after migrations/tests.
    if (existing.length) return verifyAccount(tx, credentials);
    // Also exclude ordinary application writers, which do not take our advisory
    // lock, between seed recognition and the sole account INSERT.
    await verifySeededSchema(tx);
    await tx`LOCK TABLE ONLY accounts, ONLY booths, ONLY bookings, ONLY booking_dates, ONLY inquiry_requests IN SHARE ROW EXCLUSIVE MODE`;
    await inspectSeededRows(tx);
    return insertPrivateQaAccount(tx, credentials);
  });
}

/** Only an entirely empty schema is writable. Replays only verify the account. */
export async function createQaAccount(sql, credentials) {
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SELECT pg_advisory_xact_lock(1178684741, 1)`;
    const state = await inventory(tx);
    if (state.relations.length || state.routineCount) {
      // A retry cannot overwrite anything, even if the first response was lost.
      return verifyAccount(tx, credentials);
    }
    // Do not tolerate another initializer winning after our empty check.
    // Strict CREATE makes that race fail and roll back instead of adopting it.
    for (const statement of BASE_SCHEMA) await tx.unsafe(statement.replace(' IF NOT EXISTS ', ' '));
    return insertPrivateQaAccount(tx, credentials);
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  const target = validateConfig(env, options);
  const sql = postgres(target.url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5, onnotice: () => {},
    connection: { search_path: 'public', statement_timeout: 30000 } });
  try {
    if (INSPECTIONS.has(options.command)) {
      const inspection = options.command === 'inspect-seeded-qa' ? await inspectSeededQaDatabase(sql) : await inspectQaDatabase(sql);
      console.log(JSON.stringify({ command: options.command, ...inspection, ready: false }));
      return;
    }
    let result;
    if (options.command === 'verify-existing') result = await verifyExistingQaAccount(sql, { accountId: options['account-id'], email: options.email });
    else {
      let credentials = await credentialFile(options['credentials-file'], options, target, { allowCreate: false });
      if (!credentials) {
        if (env.FAME_MARKET_ACCOUNT_ID?.trim()) fail('qa_account_mapping_conflict');
        if (options.command === 'add-to-seeded-qa') await inspectSeededQaDatabase(sql);
        else if (!(await inspectQaDatabase(sql)).empty) fail('qa_schema_not_empty');
        credentials = await credentialFile(options['credentials-file'], options, target);
      }
      if (env.FAME_MARKET_ACCOUNT_ID?.trim() && env.FAME_MARKET_ACCOUNT_ID !== credentials.accountId) fail('qa_account_mapping_conflict');
      result = options.command === 'add-to-seeded-qa'
        ? await addQaAccountToSeededDatabase(sql, credentials) : await createQaAccount(sql, credentials);
    }
    console.log(JSON.stringify({ command: options.command, ...result, ready: false,
      config: { FAME_MARKET_ACCOUNT_ID: result.accountId, FAME_SEASON_ID: '2026-2027', FAME_BOOTH_CAPACITY: options['qa-capacity'] },
      next: 'Apply and check migrations 001–021; deploy Preview and verify private manager login. QA capacity is not Production capacity.' }));
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ ready: false, error: error instanceof DatabaseReadinessError ? error.code : 'qa_bootstrap_operation_failed' }));
    process.exitCode = 1;
  });
}
