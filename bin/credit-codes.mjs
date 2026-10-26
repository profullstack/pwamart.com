#!/usr/bin/env bun
/**
 * Mint, list and revoke pwamart credit codes (Pro days) against the store's
 * database. In production, run it inside the container, which has DATABASE_URL:
 *
 *   docker exec <container> bun bin/credit-codes.mjs mint --days 365 --label "for Ada" [--max 1] [--expires-days 30]
 *   docker exec <container> bun bin/credit-codes.mjs list
 *   docker exec <container> bun bin/credit-codes.mjs revoke <code id>
 *
 * The code is printed once; only its sha256 hash is stored. Staff can do the
 * same over the API: POST /api/v1/admin/credit-codes {days, label}.
 */
import { close } from '../packages/db/src/index.js';
import { creditServices, mintCode } from '../apps/web/src/credits.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, d = null) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : d;
};

try {
  if (cmd === 'mint') {
    const m = await mintCode({
      days: Number(flag('days')),
      label: flag('label', ''),
      maxRedemptions: Number(flag('max', 1)),
      expiresInDays: flag('expires-days'),
      createdBy: flag('by', 'bin/credit-codes'),
    });
    console.log(JSON.stringify({ code: m.code, id: m.id, label: m.label, days: m.grant.amount, max: m.maxRedemptions, expires_at: m.expiresAt ? new Date(m.expiresAt).toISOString() : null }, null, 2));
  } else if (cmd === 'list') {
    for (const c of await creditServices().credits.list())
      console.log(`${c.id}  ${String(c.grant.amount).padStart(4)}d  ${c.redemptions}/${c.maxRedemptions}  ${c.revokedAt ? 'revoked ' : ''}${c.label}`);
  } else if (cmd === 'revoke' && rest[0]) {
    await creditServices().credits.revoke(rest[0]);
    console.log(`revoked ${rest[0]}`);
  } else {
    console.error('usage: credit-codes.mjs mint --days N [--label L] [--max N] [--expires-days N] | list | revoke <id>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err?.message ?? err);
  process.exitCode = 1;
} finally {
  await close();
}
