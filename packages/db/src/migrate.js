import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migrateOrgs } from '@profullstack/orgs';
import { db } from './index.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Runs on every boot, before the server listens, so a deploy cannot skip a
 * migration. Order: @profullstack/orgs' own schema (idempotent), then this app's
 * forward-only files, one transaction each. The advisory lock makes two
 * containers booting together safe.
 */
export async function migrate({ log = console.log } = {}) {
  const sql = db();
  await sql`select pg_advisory_lock(7351777)`;
  try {
    await migrateOrgs(sql);
    await sql`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await sql`select filename from schema_migrations`).map((r) => r.filename));
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[migrate] applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (filename) values (${file})`;
      });
      ran++;
    }
    log(ran ? `[migrate] applied ${ran} migration(s)` : '[migrate] up to date');
    return ran;
  } finally {
    await sql`select pg_advisory_unlock(7351777)`;
  }
}
