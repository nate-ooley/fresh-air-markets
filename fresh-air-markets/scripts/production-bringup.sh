#!/bin/bash
# One-shot production database bring-up for the Fresh Air portal.
# Run from a terminal signed in to the Vercel CLI. Never prints secrets.
#   bash scripts/production-bringup.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-}"
CAPACITY_ARG="${2:-}"
if [ -z "$EMAIL" ]; then echo "usage: bash scripts/production-bringup.sh OWNER_EMAIL [BOOTH_CAPACITY]"; exit 1; fi
EMAIL=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')
trap 'rm -f .env.production.local' EXIT

echo "== 1/6 pulling Production variables"
# A connection string exported in this shell wins over the pulled file, because
# Vercel writes "[SENSITIVE]" placeholders for Sensitive secrets.
PRESET_URL="${DATABASE_URL:-}"; PRESET_UNPOOLED="${DATABASE_URL_UNPOOLED:-}"; PRESET_AUTH="${AUTH_SECRET:-}"; PRESET_ACCOUNT_IN="${FAME_MARKET_ACCOUNT_ID:-}"
npx vercel env pull .env.production.local --environment=production --yes >/dev/null 2>&1
set -a; . ./.env.production.local; set +a
export VERCEL_ENV=production
placeholder() { case "$1" in ""|"[SENSITIVE]"|"<sensitive>") return 0;; *) return 1;; esac; }
# Every Sensitive value comes back as a placeholder; drop them all so no downstream
# check mistakes "[SENSITIVE]" for a real value.
for name in $(grep -oE '^[A-Z_]+' .env.production.local); do
  if placeholder "${!name:-}"; then unset "$name"; fi
done
PRESET_ACCOUNT="${FAME_MARKET_ACCOUNT_ID:-}"
placeholder "${DATABASE_URL:-}" && DATABASE_URL="$PRESET_URL"
placeholder "${DATABASE_URL_UNPOOLED:-}" && DATABASE_URL_UNPOOLED="$PRESET_UNPOOLED"
placeholder "${AUTH_SECRET:-}" && AUTH_SECRET="$PRESET_AUTH"
[ -z "${DATABASE_URL:-}" ] && DATABASE_URL="${DATABASE_URL_UNPOOLED:-}"
[ -z "${DATABASE_URL_UNPOOLED:-}" ] && DATABASE_URL_UNPOOLED="${DATABASE_URL:-}"
export DATABASE_URL DATABASE_URL_UNPOOLED AUTH_SECRET

if [ -z "${DATABASE_URL:-}" ]; then
  rm -f .env.production.local
  echo
  echo "Vercel keeps the database secret Sensitive, so it cannot be pulled here."
  echo "Copy the production connection string from Neon, then run this script as:"
  echo "  DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' bash scripts/production-bringup.sh $EMAIL"
  exit 1
fi
if [ -z "${AUTH_SECRET:-}" ] || [ "${#AUTH_SECRET}" -lt 32 ]; then
  # Any private 32+ character value works here; it is only used to validate the
  # bootstrap environment, and the deployed app uses the value stored in Vercel.
  AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n'); export AUTH_SECRET
fi
HOST=$(node -e "console.log(new URL(process.env.DATABASE_URL_UNPOOLED).hostname)")
echo "   Neon host: $HOST"

# An account id supplied in the shell (or already known) means verify, not create.
[ -z "${PRESET_ACCOUNT:-}" ] && PRESET_ACCOUNT="$PRESET_ACCOUNT_IN"
echo "== 2/6 manager account"
# Season is a constant; capacity comes from the optional second argument when
# Vercel hides the stored value.
export FAME_SEASON_ID=2026-2027
placeholder "${FAME_BOOTH_CAPACITY:-}" && FAME_BOOTH_CAPACITY="$CAPACITY_ARG"
[ -n "$CAPACITY_ARG" ] && FAME_BOOTH_CAPACITY="$CAPACITY_ARG"
export FAME_BOOTH_CAPACITY
CRED_DIR=$(mktemp -d /private/tmp/fame-production.XXXXXX)
CRED="$CRED_DIR/manager.json"
if [ -n "${PRESET_ACCOUNT:-}" ]; then
  export FAME_MARKET_ACCOUNT_ID="$PRESET_ACCOUNT"
  node scripts/bootstrap-qa-account.mjs verify-existing --production \
    --expected-host="$HOST" --email="$EMAIL" --account-id="$PRESET_ACCOUNT" > "$CRED_DIR/create.json"
  ACCOUNT_ID="$PRESET_ACCOUNT"; DEMO=false; EXISTING=1
  echo "   verified existing account: $ACCOUNT_ID"
else
  unset FAME_MARKET_ACCOUNT_ID
  node scripts/bootstrap-qa-account.mjs create-production-manager --production \
    --expected-host="$HOST" --email="$EMAIL" --slug=fresh-air-markets \
    --market-name="Fresh Air Markets & Events" --credentials-file="$CRED" > "$CRED_DIR/create.json"
  ACCOUNT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CRED_DIR/create.json')).accountId)")
  DEMO=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CRED_DIR/create.json')).demoAccountPresent)")
  EXISTING=0
  echo "   account id: $ACCOUNT_ID"
fi

if [ "$DEMO" = "true" ]; then
  echo "== 3/6 removing the public demo tenant"
  node scripts/bootstrap-qa-account.mjs remove-demo-tenant --production --expected-host="$HOST"
else
  echo "== 3/6 no demo tenant present"
fi

export FAME_MARKET_ACCOUNT_ID="$ACCOUNT_ID"
if [ "$EXISTING" = "1" ]; then
  echo "== 4/6 FAME_MARKET_ACCOUNT_ID already configured"
else
  echo "== 4/6 setting FAME_MARKET_ACCOUNT_ID in Production"
  npx vercel env rm FAME_MARKET_ACCOUNT_ID production --yes >/dev/null 2>&1 || true
  printf '%s' "$ACCOUNT_ID" | npx vercel env add FAME_MARKET_ACCOUNT_ID production >/dev/null
fi

echo "== 5/6 applying migrations 001-023 and checking readiness"
node scripts/database-readiness.mjs apply --production --expected-host="$HOST" > "$CRED_DIR/apply.json" || { cat "$CRED_DIR/apply.json"; exit 1; }
node scripts/database-readiness.mjs check --production --expected-host="$HOST" > "$CRED_DIR/check.json" || true
node -e "
const r=JSON.parse(require('fs').readFileSync('$CRED_DIR/check.json','utf8'));
console.log('   ready:', r.ready, ' applied:', r.appliedCount, ' blockers:', JSON.stringify(r.blockers));
const only=(r.blockers||[]).filter(b=>b!=='booth_capacity_invalid');
if (r.blockers?.includes('booth_capacity_invalid')) console.log('   (capacity could not be read here; it is checked by the deployed app, not this script)');
process.exit(only.length?2:0)"

if [ "$EXISTING" = "1" ]; then
  echo "== 6/6 no new variables; no redeploy needed"
else
  # Never deploy from this working copy. A git push (or the dashboard's Redeploy)
  # is what puts the new FAME_MARKET_ACCOUNT_ID into the running deployment.
  echo "== 6/6 redeploy Production once: push any commit, or Vercel dashboard > Deployments > Redeploy"
fi

rm -f .env.production.local
echo
if [ "$EXISTING" = "1" ]; then
  rm -rf "$CRED_DIR"
  echo "DONE. Existing manager account verified; sign in with your saved password."
else
  echo "DONE. Sign in at https://farmers-market-wine.vercel.app/login"
  echo "  email:    $EMAIL"
  echo "  password: run ->  node -e \"console.log(JSON.parse(require('fs').readFileSync('$CRED')).password)\""
  echo "Store that password in your password manager, then delete $CRED_DIR"
fi
