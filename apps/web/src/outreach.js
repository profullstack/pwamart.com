import { randomBytes } from 'node:crypto';
import { promoBlock } from '@profullstack/cross-promo';
import { db } from '@pwamart/db';
import { config } from './config.js';
import { send } from './mail.js';

/**
 * Weekly engagement outreach: at most one email a week per address, bundling every
 * nudge that applies to it, and nothing when there is nothing to do.
 *
 *   claim     an imported, unclaimed publisher: claim it free. Sent to the address
 *             the listing was submitted with on the source directory
 *             (publishers.contact_email, from bin/sync-saasrow-contacts.sh).
 *   badge     a published app whose site does not link back yet (✓, followed link, +5 karma)
 *   drafts    an app still in draft: verify the domain and publish
 *   profile   a publisher with no logo or no bio: "Fill from website"
 *   credits   an unspent karma credit: a free Featured week
 *   comments  comments from the last week the owner has not answered
 *
 * Owner digests also carry the week's installs and upvotes (the hook) and a line on
 * Featured when nothing of theirs is featured; neither alone triggers a send.
 *
 * Each repeatable nudge is capped (CAPS) so a listing nobody acts on stops being
 * mentioned. Staff, the house account and OUTREACH_EXCLUDE_DOMAINS are never mailed.
 * One-click unsubscribe (RFC 8058) per address in outreach_recipients.
 *
 * OUTREACH=off stops it, OUTREACH=dry logs what would go out without sending.
 */

export const CAPS = { claim: 8, badge: 6, drafts: 4, profile: 4 };
export const GAP_HOURS = 156; // 6.5 days, so an hourly job keeps a weekly rhythm
const ACTIONABLE = ['claim', 'badge', 'drafts', 'profile', 'credits', 'comments'];

const env = (k, d = '') => process.env[k] ?? d;
export const outreachConfig = {
  get mode() {
    return env('OUTREACH', 'on');
  },
  get batch() {
    return Number(env('OUTREACH_BATCH', '60')) || 60;
  },
  get excludeDomains() {
    return env('OUTREACH_EXCLUDE_DOMAINS', 'profullstack.com,pwamart.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  /** CAN-SPAM wants a postal address in commercial mail; appended to every digest when set. */
  get postal() {
    return env('OUTREACH_POSTAL');
  },
  get replyTo() {
    return env('OUTREACH_REPLY_TO');
  },
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (names, max = 3) =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

export function excluded(email, { adminEmails = config.adminEmails, domains = outreachConfig.excludeDomains } = {}) {
  const e = String(email ?? '').toLowerCase().trim();
  if (!e.includes('@')) return true;
  if (e === 'unclaimed@pwamart.com' || adminEmails.includes(e)) return true;
  if (/@coinpay\./.test(e)) return true; // CoinPay-only accounts carry a placeholder nobody reads
  const host = e.split('@')[1];
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ---------------------------------------------------------------- compose -- */

/** The claim section: every unclaimed publisher submitted with this address. */
export function claimSection(publishers, siteUrl) {
  const appNames = publishers.flatMap((p) => p.apps);
  const lines = publishers.map(
    (p) =>
      `* ${p.name} (${p.domain})${p.apps.length ? `: ${listOf(p.apps)}` : ''}\n  Claim it: ${siteUrl}/console/claim/${p.slug}\n  See it:   ${siteUrl}/publishers/${p.slug}`,
  );
  return {
    subject:
      appNames.length === 1
        ? `${appNames[0]} is listed on pwamart: claim it free`
        : `${plural(appNames.length || publishers.length, 'app')} of yours are listed on pwamart: claim them free`,
    text:
      `Your ${publishers.length === 1 ? 'listing is' : 'listings are'} on pwamart.com, the app store for Progressive Web Apps, imported from your saasrow.com submission. ${publishers.length === 1 ? 'It is' : 'They are'} unclaimed right now.\n\n` +
      `${lines.join('\n\n')}\n\n` +
      `Claiming is free and takes a minute: add a DNS TXT record or a token on your site, and the listing moves to your account. Then you can:\n` +
      `- edit the description, logo and screenshots\n` +
      `- add the badge for a verified ✓ and a followed backlink from pwamart\n` +
      `- see installs, reply to comments and post release notes\n` +
      `- feature it on the home page and in the newsletter\n\n` +
      `The Free plan covers 1 publisher and 10 apps.`,
  };
}

/** The owner section: the week's numbers, then each nudge that applies. */
export function ownerSection(o, siteUrl) {
  const parts = [];
  const kinds = [];
  if (o.stats.installs || o.stats.votes) {
    const top = o.stats.top ? ` ${o.stats.top.name} led with ${plural(o.stats.top.installs, 'install')}.` : '';
    parts.push(`This week on pwamart: ${plural(o.stats.installs, 'install')} and ${plural(o.stats.votes, 'upvote')} across your apps.${top}`);
  }
  if (o.comments?.length) {
    kinds.push('comments');
    parts.push(
      `People are talking. Unanswered comments from the last week:\n` +
        o.comments.map((c) => `* ${plural(c.count, 'comment')} on ${c.name}: ${siteUrl}/apps/${c.slug}#comments`).join('\n'),
    );
  }
  if (o.credits) {
    kinds.push('credits');
    parts.push(
      `You have ${plural(o.credits, 'free Featured week')} from karma: home page, newsletter and a free ad across the CrawlProof network. Spend it: ${siteUrl}/console/feature`,
    );
  }
  if (o.badge?.length) {
    kinds.push('badge');
    const a = o.badge[0];
    parts.push(
      `Add the pwamart badge to ${listOf(o.badge.map((b) => b.name))}. A site that links back gets the verified ✓, a followed link from its listing and +5 karma. Paste this on ${a.host}:\n\n` +
        `<a href="${siteUrl}/apps/${a.slug}?ref=badge"><img src="${siteUrl}/apps/${a.slug}/badge.svg" alt="Get ${a.name} on pwamart" width="200" height="44"></a>\n\n` +
        `More styles: ${siteUrl}/apps/${a.slug}#badge`,
    );
  }
  if (o.drafts?.length) {
    kinds.push('drafts');
    parts.push(`${listOf(o.drafts.map((d) => d.name))} ${o.drafts.length === 1 ? 'is' : 'are'} still a draft. Verify the domain and publish: ${siteUrl}/console`);
  }
  if (o.profile?.length) {
    kinds.push('profile');
    const p = o.profile[0];
    parts.push(
      `${listOf(o.profile.map((x) => x.name))} ${o.profile.length === 1 ? 'has' : 'have'} no ${p.missing}. "Fill from website" pulls your logo and description in one click: ${siteUrl}/console/publishers/${p.slug}`,
    );
  }
  if (!o.featured && kinds.length) {
    parts.push(`Want more installs? Featured puts an app on the home page and in the newsletter for a week, with a free CrawlProof ad: ${siteUrl}/featured`);
  }
  const subject = o.stats.installs
    ? `Your pwamart week: ${plural(o.stats.installs, 'install')}`
    : o.comments?.length
      ? `New comments on ${o.comments[0].name} on pwamart`
      : `${plural(kinds.length, 'quick win')} for your apps on pwamart`;
  return { subject, text: parts.join('\n\n'), kinds };
}

/** One email from whatever sections apply; null when nothing actionable remains. */
export function composeDigest({ claim, owner, siteUrl, unsubUrl, postal = '', promo = '' }) {
  const sections = [];
  const kinds = [];
  let subject = null;
  if (owner) {
    const s = ownerSection(owner, siteUrl);
    if (s.kinds.length) {
      sections.push(s.text);
      kinds.push(...s.kinds);
      subject = s.subject;
    }
  }
  if (claim?.length) {
    const s = claimSection(claim, siteUrl);
    sections.push(s.text);
    kinds.push('claim');
    subject ??= s.subject;
  }
  if (!kinds.some((k) => ACTIONABLE.includes(k))) return null;
  const why = claim?.length && !owner ? 'your site was submitted to saasrow.com with this address' : 'you publish apps on pwamart';
  const footer = `--\nYou get at most one of these a week because ${why}.\nStop them: ${unsubUrl}${postal ? `\n${postal}` : ''}`;
  return { subject, text: `Hi,\n\n${sections.join('\n\n')}\n\n${promo ? `${promo}\n\n` : ''}${footer}\n`, kinds };
}

/** Drop nudges that already hit their cap for this address. */
export function applyCaps({ claim, owner }, counts = {}) {
  const over = (k) => CAPS[k] != null && (counts[k] ?? 0) >= CAPS[k];
  const o = owner && {
    ...owner,
    badge: over('badge') ? [] : owner.badge,
    drafts: over('drafts') ? [] : owner.drafts,
    profile: over('profile') ? [] : owner.profile,
  };
  return { claim: over('claim') ? [] : claim, owner: o };
}

/* ---------------------------------------------------------------- targets -- */

/** email -> unclaimed publishers submitted with it. */
export async function claimTargets(sql = db()) {
  const rows = await sql`
    select lower(p.contact_email) as email, p.slug, p.name, p.claim_domain as domain,
           coalesce(array_agg(a.name order by a.installs desc, a.name) filter (where a.id is not null), '{}') as apps
    from publishers p
    left join apps a on a.publisher_id = p.id and a.status = 'published'
    where p.claimable and p.contact_email is not null
    group by p.id
    order by p.created_at`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.email)) out.set(r.email, []);
    out.get(r.email).push({ slug: r.slug, name: r.name, domain: r.domain, apps: r.apps });
  }
  return out;
}

const host = (origin) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
};

/** email -> what the owner of claimed publishers could do this week. */
export async function ownerTargets(sql = db()) {
  const apps = await sql`
    select distinct on (u.id, a.id) lower(u.email) as email, u.id as user_id, a.id, a.slug, a.name, a.origin, a.status,
           a.badge_verified_at, a.badge_checked_at, a.featured, a.featured_until
    from users u
    join org_members m on m.user_id = u.id and m.role in ('owner', 'admin')
    join publishers p on p.org_id = m.org_id and not p.claimable
    join apps a on a.publisher_id = p.id and a.status in ('published', 'draft')
    where not u.is_admin`;
  const pubs = await sql`
    select distinct on (u.id, p.id) lower(u.email) as email, p.slug, p.name, p.avatar_url, p.bio
    from users u
    join org_members m on m.user_id = u.id and m.role in ('owner', 'admin')
    join publishers p on p.org_id = m.org_id and not p.claimable
    where not u.is_admin and (p.avatar_url is null or p.bio is null or p.bio = '')`;
  const installs = await sql`
    select app_id, count(*)::int as n from app_installs where created_at > now() - interval '7 days' group by 1`;
  const votes = await sql`select app_id, count(*)::int as n from app_votes where created_at > now() - interval '7 days' group by 1`;
  const credits = await sql`select user_id, count(*)::int as n from karma_credits where spent_at is null group by 1`;
  // A top-level comment from someone else in the last week with no reply from the owner's org.
  const comments = await sql`
    select a.id as app_id, count(*)::int as n
    from app_comments c
    join apps a on a.id = c.app_id
    join publishers p on p.id = a.publisher_id
    where c.parent_id is null and c.deleted_at is null and c.created_at > now() - interval '7 days'
      and not exists (select 1 from org_members m where m.org_id = p.org_id and m.user_id = c.user_id)
      and not exists (
        select 1 from app_comments r join org_members m on m.user_id = r.user_id and m.org_id = p.org_id
        where r.parent_id = c.id and r.deleted_at is null)
    group by 1`;
  const byApp = (rows) => new Map(rows.map((r) => [r.app_id, r.n]));
  const inst = byApp(installs);
  const vote = byApp(votes);
  const com = byApp(comments);
  const cred = new Map(credits.map((r) => [r.user_id, r.n]));

  const out = new Map();
  const get = (email, userId) => {
    if (!out.has(email))
      out.set(email, { userId, badge: [], drafts: [], profile: [], comments: [], credits: 0, featured: false, stats: { installs: 0, votes: 0, top: null } });
    return out.get(email);
  };
  for (const a of apps) {
    const o = get(a.email, a.user_id);
    o.credits = cred.get(a.user_id) ?? 0;
    if (a.featured || (a.featured_until && new Date(a.featured_until) > new Date())) o.featured = true;
    if (a.status === 'draft') {
      o.drafts.push({ slug: a.slug, name: a.name });
      continue;
    }
    // Only once the daemon has looked: a never-checked listing may already link back.
    if (!a.badge_verified_at && a.badge_checked_at) o.badge.push({ slug: a.slug, name: a.name, host: host(a.origin) });
    const n = inst.get(a.id) ?? 0;
    o.stats.installs += n;
    o.stats.votes += vote.get(a.id) ?? 0;
    if (n && (!o.stats.top || n > o.stats.top.installs)) o.stats.top = { name: a.name, installs: n };
    if (com.get(a.id)) o.comments.push({ slug: a.slug, name: a.name, count: com.get(a.id) });
  }
  for (const p of pubs) {
    const o = out.get(p.email);
    if (!o) continue; // a publisher with no apps yet gets nothing from us
    const missing = [!p.avatar_url && 'logo', !(p.bio && p.bio.trim()) && 'bio'].filter(Boolean).join(' or ');
    o.profile.push({ slug: p.slug, name: p.name, missing });
  }
  return out;
}

/* ------------------------------------------------------------- recipients -- */

/** The address's unsubscribe token, created on first use. */
export async function tokenFor(email, sql = db()) {
  const [row] = await sql`
    insert into outreach_recipients (email, token) values (${email}, ${randomBytes(18).toString('base64url')})
    on conflict (email) do update set email = excluded.email returning token, opted_out_at`;
  return row;
}

export const unsubscribeUrl = (token) => `${config.siteUrl}/outreach/unsubscribe?t=${encodeURIComponent(token)}`;

export async function unsubscribe(token, sql = db()) {
  if (!token) return null;
  const [row] = await sql`
    update outreach_recipients set opted_out_at = coalesce(opted_out_at, now()) where token = ${String(token)} returning email`;
  return row ?? null;
}

export async function recipientByToken(token, sql = db()) {
  if (!token) return null;
  const [row] = await sql`select email, opted_out_at from outreach_recipients where token = ${String(token)}`;
  return row ?? null;
}

/* -------------------------------------------------------------------- run -- */

/**
 * One daemon turn: up to `batch` addresses that are due (no digest in GAP_HOURS, not
 * opted out), owners first. Returns a tally; with dry, logs instead of sending.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runOutreach({
  sql = db(),
  batch = outreachConfig.batch,
  dry = outreachConfig.mode === 'dry',
  sendFn = send,
  siteUrl = config.siteUrl,
  pauseMs = Number(env('OUTREACH_PAUSE_MS', '300')),
  retryMs = 3000,
} = {}) {
  const [claims, owners] = await Promise.all([claimTargets(sql), ownerTargets(sql)]);
  const recent = new Set(
    (await sql`select distinct email from outreach_sends where sent_at > now() - make_interval(hours => ${GAP_HOURS})`).map((r) => r.email),
  );
  const optedOut = new Set((await sql`select email from outreach_recipients where opted_out_at is not null`).map((r) => r.email));
  const counts = new Map();
  for (const r of await sql`select email, k, count(*)::int as n from outreach_sends, unnest(kinds) k group by 1, 2`) {
    if (!counts.has(r.email)) counts.set(r.email, {});
    counts.get(r.email)[r.k] = r.n;
  }

  const emails = [...new Set([...owners.keys(), ...claims.keys()])].filter((e) => !excluded(e) && !recent.has(e) && !optedOut.has(e));
  const tally = { due: emails.length, sent: 0, skipped: 0, failed: 0, kinds: {} };
  for (const email of emails) {
    if (tally.sent >= batch) break;
    const capped = applyCaps({ claim: claims.get(email), owner: owners.get(email) }, counts.get(email));
    const { token } = dry ? { token: 'dry-run' } : await tokenFor(email, sql);
    const unsub = unsubscribeUrl(token);
    // The network block (@profullstack/cross-promo), as on every pwamart email; never throws.
    const promo = await promoBlock({ site: 'pwamart.com', audience: 'makers', seed: email })
      .then((p) => p.text ?? '')
      .catch(() => '');
    const msg = composeDigest({ ...capped, siteUrl, unsubUrl: unsub, postal: outreachConfig.postal, promo });
    if (!msg) {
      tally.skipped++;
      continue;
    }
    if (dry) {
      console.log(`[outreach] (dry) to=${email} kinds=${msg.kinds.join(',')} subject=${msg.subject}`);
    } else {
      const mail = {
        to: email,
        subject: msg.subject,
        text: msg.text,
        replyTo: outreachConfig.replyTo || undefined,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      };
      // Resend allows 10 requests/s for the whole account (every fleet site shares it):
      // pace the batch, and give a 429 one more try after a pause.
      if (tally.sent && pauseMs) await sleep(pauseMs);
      try {
        await sendFn(mail).catch(async (err) => {
          if (!/\b429\b/.test(String(err?.message))) throw err;
          await sleep(retryMs);
          return sendFn(mail);
        });
      } catch (err) {
        tally.failed++;
        console.error(`[outreach] ${email}: ${err?.message ?? err}`);
        continue;
      }
      await sql`insert into outreach_sends (email, kinds, subject) values (${email}, ${msg.kinds}::text[], ${msg.subject})`;
    }
    tally.sent++;
    for (const k of msg.kinds) tally.kinds[k] = (tally.kinds[k] ?? 0) + 1;
  }
  return tally;
}

/**
 * Contacts for imported publishers, from the source directory: [{source_ref, email}].
 * Only fills an empty contact_email on a still-claimable publisher.
 */
export async function setContacts(rows, { source = 'saasrow', sql = db() } = {}) {
  let updated = 0;
  for (const r of rows) {
    const email = String(r.email ?? '').trim().toLowerCase();
    if (!r.source_ref || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    const res = await sql`
      update publishers set contact_email = ${email}
      where source = ${source} and source_ref = ${String(r.source_ref)} and claimable
        and contact_email is distinct from ${email}`;
    updated += res.count;
  }
  return { rows: rows.length, updated };
}
