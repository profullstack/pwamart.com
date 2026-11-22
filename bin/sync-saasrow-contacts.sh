#!/usr/bin/env bash
# Copy the submitter's email of every unclaimed saasrow-imported publisher into
# publishers.contact_email, so the weekly outreach digest (apps/web/src/outreach.js)
# can send "claim your listing for free".
#
# saasrow keeps the owner's address only in submission_contacts (RLS-locked, no
# public API), keyed by software_submissions.id = our publishers.source_ref. Both
# databases are on dev2, so this runs there from cron and needs no new secret:
#
#   17 3 * * * ~/src/profullstack/pwamart.com/bin/sync-saasrow-contacts.sh >> ~/.local/state/pwamart-contacts.log 2>&1
#
# Env: PWAMART_CONTAINER (pwamartcom-app-1), SAASROW_DB_CONTAINER (saasrow-com-supabase-db)
set -euo pipefail

APP="${PWAMART_CONTAINER:-pwamartcom-app-1}"
SDB="${SAASROW_DB_CONTAINER:-saasrow-com-supabase-db}"
work="$(mktemp -d "${XDG_RUNTIME_DIR:-$HOME}/.pwamart-contacts.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 1. The ids of every still-claimable saasrow publisher.
docker exec -w /app/apps/web "$APP" bun -e '
  import { db } from "@pwamart/db";
  const rows = await db()`select source_ref from publishers where claimable and source = ${"saasrow"} and source_ref is not null`;
  for (const r of rows) console.log(r.source_ref);
  process.exit(0);
' | grep -E '^[0-9a-f-]{36}$' > "$work/refs.txt" || true

if [ ! -s "$work/refs.txt" ]; then
  echo "$(date -u +%FT%TZ) no claimable saasrow publishers"
  exit 0
fi

# 2. Their submitter emails from saasrow, as id<TAB>email.
{
  echo 'create temp table r (id uuid primary key);'
  echo 'copy r from stdin;'
  cat "$work/refs.txt"
  echo '\.'
  echo "copy (select c.submission_id, lower(c.email) from r join submission_contacts c on c.submission_id = r.id) to stdout;"
} | docker exec -i "$SDB" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 > "$work/contacts.tsv"

# 3. Into pwamart (fills or corrects contact_email; never touches claimed publishers).
docker exec -i -w /app/apps/web "$APP" bun -e '
  import { setContacts } from "./src/outreach.js";
  const text = await Bun.stdin.text();
  const rows = text.split("\n").filter(Boolean).map((l) => { const [source_ref, email] = l.split("\t"); return { source_ref, email }; });
  console.log(JSON.stringify(await setContacts(rows)));
  process.exit(0);
' < "$work/contacts.tsv" | sed "s/^/$(date -u +%FT%TZ) /"
