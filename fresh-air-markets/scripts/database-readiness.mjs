import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

const migrationDirectory = new URL('../docs/migrations/', import.meta.url);
const baseTables = ['accounts', 'booths', 'bookings', 'booking_dates'];
const historyTable = 'fame_schema_migrations';

export class DatabaseReadinessError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new DatabaseReadinessError(code); }

// Split only at SQL statement boundaries. In particular, BEGIN/END inside a
// dollar-quoted function or DO block must never escape the enclosing transaction.
export function transactionBody(source) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollar = null;
  let lineComment = false;
  let blockDepth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockDepth) {
      if (c === '/' && n === '*') { blockDepth++; i++; }
      else if (c === '*' && n === '/') { blockDepth--; i++; }
      continue;
    }
    if (dollar) {
      if (source.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (quote) {
      if (c === quote) { if (n === quote) i++; else quote = null; }
      continue;
    }
    if (c === '-' && n === '-') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockDepth = 1; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '$') {
      const match = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) { dollar = match[0]; i += dollar.length - 1; continue; }
    }
    if (c === ';') { statements.push(source.slice(start, i + 1)); start = i + 1; }
  }
  if (quote || dollar || blockDepth) fail('migration_unterminated_sql');
  const meaningful = statements.map(text => ({ text, code: text.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim() }))
    .filter(statement => statement.code);
  const tail = source.slice(start).replace(/(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)/g, '');
  if (tail) fail('migration_missing_statement_terminator');
  if (/^BEGIN\s*;$/i.test(meaningful[0]?.code ?? '')) {
    if (!/^COMMIT\s*;$/i.test(meaningful.at(-1)?.code ?? '')) fail('migration_unbalanced_transaction');
    meaningful.shift(); meaningful.pop();
  }
  if (meaningful.some(({ code }) => /^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|PREPARE\s+TRANSACTION|VACUUM)\b/i.test(code)
    || /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(code))) fail('migration_unsafe_transaction_control');
  return meaningful.map(statement => statement.text).join('\n');
}

export async function loadMigrations(directory = migrationDirectory) {
  const names = (await readdir(directory)).filter(name => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
  if (!names.length || names.some((name, index) => Number(name.slice(0, 3)) !== index + 1)) fail('migration_sequence_invalid');
  return Promise.all(names.map(async name => {
    const source = await readFile(new URL(name, directory), 'utf8');
    return { name, checksum: createHash('sha256').update(source).digest('hex'), sql: transactionBody(source), source };
  }));
}

function connection(value) {
  let url;
  try { url = new URL(value); } catch { fail('database_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.hostname
    || url.pathname.length < 2 || url.hash || url.searchParams.has('options')) fail('database_url_invalid');
  return url;
}
const directHost = hostname => hostname.replace(/-pooler(?=\.)/, '');

export function resolveQaTarget(env, { qa, expectedHost }) {
  if (qa !== true || env.VERCEL_ENV !== 'preview') fail('preview_qa_target_required');
  const pooled = connection(env.DATABASE_URL);
  const direct = env.DATABASE_URL_UNPOOLED ? connection(env.DATABASE_URL_UNPOOLED) : pooled;
  if (directHost(pooled.hostname) !== directHost(direct.hostname) || pooled.pathname !== direct.pathname
    || pooled.username !== direct.username) fail('database_urls_target_mismatch');
  if (!expectedHost || directHost(direct.hostname) !== directHost(expectedHost.toLowerCase())) fail('database_expected_host_mismatch');
  if (!direct.hostname.endsWith('.neon.tech') || direct.searchParams.get('sslmode') !== 'require') fail('neon_tls_required');
  return { url: direct.toString(), host: direct.hostname };
}

export function expectedObjects(migrations) {
  const objects = baseTables.map(name => ({ kind: 'table', name }));
  for (const { source } of migrations) {
    for (const match of source.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) objects.push({ kind: 'table', name: match[1] });
    for (const match of source.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) objects.push({ kind: 'index', name: match[1] });
    for (const match of source.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_][a-z0-9_]*)/gi)) objects.push({ kind: 'trigger', name: match[1] });
    for (const match of source.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z_][a-z0-9_]*)/gi)) objects.push({ kind: 'view', name: match[1] });
  }
  return [...new Map(objects.map(object => [`${object.kind}:${object.name}`, object])).values()];
}

export function compareHistory(migrations, history) {
  const expected = new Map(migrations.map(m => [m.name, m.checksum]));
  for (const row of history) {
    if (!expected.has(row.name)) fail('migration_history_unknown_version');
    if (expected.get(row.name) !== row.checksum) fail('migration_checksum_mismatch');
  }
  const applied = new Set(history.map(row => row.name));
  let pendingSeen = false;
  for (const migration of migrations) {
    if (!applied.has(migration.name)) pendingSeen = true;
    else if (pendingSeen) fail('migration_history_out_of_order');
  }
  return migrations.filter(m => !applied.has(m.name));
}

async function catalog(sql) {
  const relations = await sql`SELECT c.relname AS name, CASE WHEN c.relkind = 'i' THEN 'index' WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS kind,
      COALESCE(i.indisvalid, true) AS valid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'i', 'v')`;
  const triggers = await sql`SELECT t.tgname AS name, 'trigger' AS kind, t.tgenabled IN ('O', 'A') AS valid
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND NOT t.tgisinternal`;
  return [...relations, ...triggers];
}

export async function inspectSchema(sql, migrations, env = {}) {
  const objects = await catalog(sql);
  const known = new Set(objects.filter(object => object.valid).map(object => `${object.kind}:${object.name}`));
  const missingObjects = expectedObjects(migrations).filter(object => !known.has(`${object.kind}:${object.name}`));
  const history = known.has(`table:${historyTable}`) ? await sql`SELECT name, checksum FROM fame_schema_migrations ORDER BY name` : [];
  const pending = compareHistory(migrations, history).map(m => m.name);
  const blockers = [];
  if (missingObjects.length) blockers.push('schema_objects_missing_or_disabled');
  if (pending.length) blockers.push('migration_history_incomplete');
  const marketId = env.FAME_MARKET_ACCOUNT_ID?.trim();
  if (!marketId) blockers.push('market_account_id_missing');
  else if (marketId === 'demo-market') blockers.push('demo_account_not_fresh_air');
  else if (known.has('table:accounts')) {
    const rows = await sql`SELECT id FROM accounts WHERE id = ${marketId}`;
    if (rows.length !== 1) blockers.push('configured_market_account_not_found');
  }
  if (env.FAME_SEASON_ID !== '2026-2027') blockers.push('season_id_invalid');
  if (!/^[1-9]\d{0,3}$/.test(env.FAME_BOOTH_CAPACITY ?? '')) blockers.push('booth_capacity_invalid');
  return { ready: blockers.length === 0, appliedCount: history.length, pending, missingObjects, blockers };
}

// All files and their checksums commit together. Transaction-scoped locking
// also works through a pooler and disappears automatically after disconnect.
export async function applyMigrations(sql, migrations) {
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SELECT pg_advisory_xact_lock(1178684741, 1)`;
    const present = new Set((await catalog(tx)).filter(o => o.kind === 'table').map(o => o.name));
    if (baseTables.some(name => !present.has(name))) fail('base_portal_schema_required');
    await tx`CREATE TABLE IF NOT EXISTS fame_schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    const history = await tx`SELECT name, checksum FROM fame_schema_migrations ORDER BY name`;
    const pending = compareHistory(migrations, history);
    for (const migration of pending) {
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO fame_schema_migrations (name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
    }
    const objects = new Set((await catalog(tx)).filter(o => o.valid).map(o => `${o.kind}:${o.name}`));
    if (expectedObjects(migrations).some(o => !objects.has(`${o.kind}:${o.name}`))) fail('migration_schema_verification_failed');
    return { applied: pending.map(m => m.name), alreadyAppliedCount: history.length };
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const command = args[0] ?? 'plan';
  if (!['plan', 'check', 'apply'].includes(command) || args.slice(1).some(a => a !== '--qa' && !a.startsWith('--expected-host='))) fail('usage_plan_check_apply');
  const migrations = await loadMigrations();
  if (command === 'plan') {
    console.log(JSON.stringify({ command, migrations: migrations.map(({ name, checksum }) => ({ name, checksum })) }, null, 2));
    return;
  }
  const target = resolveQaTarget(env, { qa: args.includes('--qa'), expectedHost: args.find(a => a.startsWith('--expected-host='))?.slice(16) });
  const sql = postgres(target.url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
    onnotice: () => {}, connection: { search_path: 'public', statement_timeout: 120000 } });
  try {
    const result = command === 'apply' ? await applyMigrations(sql, migrations) : undefined;
    const readiness = await sql.begin('READ ONLY', tx => inspectSchema(tx, migrations, env));
    console.log(JSON.stringify({ command, targetHost: target.host, migrations: result, ...readiness }, null, 2));
    if (!readiness.ready) process.exitCode = 2;
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    // Database/provider errors can contain connection strings or stored rows.
    // Emit only our fixed error codes, never their message, stack, or detail.
    console.error(JSON.stringify({ ready: false, error: error instanceof DatabaseReadinessError ? error.code : 'database_operation_failed' }));
    process.exitCode = 1;
  });
}
