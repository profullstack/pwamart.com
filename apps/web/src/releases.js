import { createHash, randomBytes } from 'node:crypto';
import { sendPush, vapidKeysFromEnv } from '@profullstack/notifications/server';
import { db } from '@pwamart/db';
import { config } from './config.js';
import { inspect } from './inspect.js';
import { send } from './mail.js';

/**
 * Releases and following.
 *
 * A release is one "what's new" entry for an app:
 *   launched   the app went live (made by the daemon for every published app)
 *   publisher  written by the publisher (console, API, CLI, MCP)
 *   detected   the daemon re-read the manifest and something people see changed
 *
 * People follow an app or a publisher (a publisher's followers hear about all of
 * its apps, new ones included) by account, by email (double opt-in) or by browser
 * push. Each release becomes one delivery per follower per channel, claimed
 * before it is sent, so a restart never sends twice.
 */

/* ------------------------------------------------------------ detection -- */

const WATCHED = {
  name: 'name',
  short_name: 'short name',
  description: 'description',
  icon: 'icon',
  screenshots: 'screenshots',
  theme_color: 'colours',
  start_url: 'start page',
  display: 'window mode',
};

/** The manifest fields a person would notice, normalised, plus their hash. */
export function fingerprint(report) {
  const m = report.manifest ?? {};
  const fields = {
    name: m.name ?? null,
    short_name: m.short_name ?? null,
    description: m.description ?? null,
    icon: report.app?.icon ?? null,
    screenshots: (report.app?.screenshots ?? []).map((s) => s.src).sort(),
    theme_color: m.theme_color ?? null,
    start_url: report.app?.startUrl ?? null,
    display: report.app?.display ?? null,
  };
  return { fields, hash: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}

export function describeChanges(before, after) {
  const changed = Object.keys(WATCHED).filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null));
  const title = changed.length ? `Updated: new ${changed.map((k) => WATCHED[k]).join(', ')}` : 'Updated';
  return { changed, title };
}

/**
 * Daemon turn: re-inspect the listings checked longest ago (each roughly daily),
 * record a `detected` release when their fingerprint changes, and refresh the
 * listing to match. The first look only records a baseline.
 */
export async function runReleaseDetect({ batch = 20, inspectFn = inspect, sql = db() } = {}) {
  const due = await sql`
    select id, slug, url, origin, manifest_hash, manifest_fields from apps
    where status = 'published' and (release_checked_at is null or release_checked_at < now() - interval '22 hours')
    order by release_checked_at nulls first limit ${batch}`;
  let releases = 0;
  for (const a of due) {
    let report;
    try {
      report = await inspectFn(a.url);
    } catch {
      await sql`update apps set release_checked_at = now() where id = ${a.id}`;
      continue;
    }
    if (report.origin !== a.origin || !report.manifest) {
      await sql`update apps set release_checked_at = now() where id = ${a.id}`;
      continue;
    }
    const fp = fingerprint(report);
    if (a.manifest_hash && a.manifest_hash !== fp.hash) {
      const { changed, title } = describeChanges(a.manifest_fields, fp.fields);
      await sql.begin(async (tx) => {
        await tx`insert into app_releases (app_id, kind, title, changes) values (${a.id}, 'detected', ${title}, ${tx.json(changed)})`;
        await tx`update apps set manifest = ${tx.json(report.manifest)}, icon_url = coalesce(${report.app.icon ?? null}, icon_url),
                 screenshots = ${tx.json(report.app.screenshots ?? [])}, theme_color = ${report.app.themeColor ?? null},
                 display = ${report.app.display ?? null}, updated_at = now() where id = ${a.id}`;
      });
      releases++;
    }
    await sql`update apps set manifest_hash = ${fp.hash}, manifest_fields = ${sql.json(fp.fields)}, release_checked_at = now() where id = ${a.id}`;
  }
  return { checked: due.length, releases };
}

/** Every published app gets a `launched` entry; old ones are marked as already announced. */
export async function backfillLaunches(sql = db()) {
  const rows = await sql`
    insert into app_releases (app_id, kind, title, created_at, notified_at)
    select a.id, 'launched', 'Now on pwamart', coalesce(a.published_at, now()),
           case when coalesce(a.published_at, now()) < now() - interval '1 day' then now() end
    from apps a
    where a.status = 'published' and not exists (select 1 from app_releases r where r.app_id = a.id and r.kind = 'launched')
    returning id`;
  return rows.length;
}

/* -------------------------------------------------------------- follows -- */

/**
 * Follow an app or a publisher. A signed-in user is confirmed at once; a bare email
 * gets a confirmation link; a browser push subscription is its own consent.
 */
export async function follow({ kind, targetId, user = null, email = null, push = null, sql = db() }) {
  let pushId = null;
  if (push?.endpoint && push?.keys?.p256dh && push?.keys?.auth) {
    const [p] = await sql`
      insert into push_subscriptions (endpoint, keys, user_id) values (${push.endpoint}, ${sql.json(push.keys)}, ${user?.id ?? null})
      on conflict (endpoint) do update set keys = excluded.keys, user_id = coalesce(excluded.user_id, push_subscriptions.user_id), failures = 0
      returning id`;
    pushId = p.id;
  }
  const token = randomBytes(18).toString('base64url');
  if (user) {
    const [f] = await sql`
      insert into follows (target_kind, target_id, user_id, push_id, token, confirmed_at)
      values (${kind}, ${targetId}, ${user.id}, ${pushId}, ${token}, now())
      on conflict (target_kind, target_id, user_id) where user_id is not null
      do update set push_id = coalesce(excluded.push_id, follows.push_id)
      returning *`;
    return { follow: f, needsConfirm: false };
  }
  if (email) {
    const e = String(email).trim().toLowerCase();
    const [f] = await sql`
      insert into follows (target_kind, target_id, email, push_id, token)
      values (${kind}, ${targetId}, ${e}, ${pushId}, ${token})
      on conflict (target_kind, target_id, lower(email)) where email is not null and user_id is null
      do update set push_id = coalesce(excluded.push_id, follows.push_id)
      returning *`;
    return { follow: f, needsConfirm: !f.confirmed_at };
  }
  if (pushId) {
    const [f] = await sql`
      insert into follows (target_kind, target_id, push_id, token, confirmed_at)
      values (${kind}, ${targetId}, ${pushId}, ${token}, now())
      on conflict (target_kind, target_id, push_id) where push_id is not null and user_id is null and email is null
      do update set confirmed_at = coalesce(follows.confirmed_at, now())
      returning *`;
    return { follow: f, needsConfirm: false };
  }
  throw Object.assign(new Error('sign in, give an email, or allow notifications in this browser'), { status: 400 });
}

/* ------------------------------------------------------------ delivery -- */

/** Turn each new release into deliveries for its app's and its publisher's followers. */
export async function queueDeliveries(sql = db()) {
  const releases = await sql`select r.id, r.app_id, a.publisher_id from app_releases r join apps a on a.id = r.app_id where r.notified_at is null and a.status = 'published' order by r.created_at limit 50`;
  for (const r of releases) {
    await sql.begin(async (tx) => {
      const follows = await tx`
        select distinct on (coalesce(f.user_id::text, lower(f.email), f.push_id::text)) f.id, f.user_id, f.email, f.push_id
        from follows f
        where f.confirmed_at is not null
          and ((f.target_kind = 'app' and f.target_id = ${r.app_id}) or (f.target_kind = 'publisher' and f.target_id = ${r.publisher_id}))
        order by coalesce(f.user_id::text, lower(f.email), f.push_id::text), (f.target_kind = 'app') desc`;
      for (const f of follows) {
        if (f.user_id || f.email) await tx`insert into release_deliveries (release_id, follow_id, channel) values (${r.id}, ${f.id}, 'email') on conflict do nothing`;
        if (f.push_id) await tx`insert into release_deliveries (release_id, follow_id, channel) values (${r.id}, ${f.id}, 'push') on conflict do nothing`;
      }
      await tx`update app_releases set notified_at = now() where id = ${r.id}`;
    });
  }
  return releases.length;
}

let pushSender = sendPush;
export const setPushSender = (f) => {
  pushSender = f;
};

/** Send due deliveries. Each row is claimed (sent_at set) before it goes out. */
export async function sendDeliveries({ batch = 60, sql = db() } = {}) {
  const due = await sql`
    update release_deliveries d set sent_at = now()
    from (select release_id, follow_id, channel from release_deliveries where sent_at is null and error is null limit ${batch} for update skip locked) x
    where d.release_id = x.release_id and d.follow_id = x.follow_id and d.channel = x.channel
    returning d.release_id, d.follow_id, d.channel`;
  const keys = vapidKeysFromEnv();
  let sent = 0;
  for (const d of due) {
    const [row] = await sql`
      select r.title, r.notes, r.version, r.kind, a.slug, a.name, a.icon_url, f.token, f.target_kind,
             coalesce(u.email, f.email) as email, p.endpoint, p.keys, p.id as push_id, pub.name as publisher_name
      from app_releases r join apps a on a.id = r.app_id join publishers pub on pub.id = a.publisher_id
      join follows f on f.id = ${d.follow_id} left join users u on u.id = f.user_id
      left join push_subscriptions p on p.id = f.push_id
      where r.id = ${d.release_id}`;
    if (!row) continue;
    const page = `${config.siteUrl}/apps/${row.slug}/releases`;
    const heading = row.kind === 'launched' ? `New from ${row.publisher_name}: ${row.name}` : `${row.name}: ${row.title}${row.version ? ` (${row.version})` : ''}`;
    try {
      if (d.channel === 'email' && row.email) {
        await send({
          to: row.email,
          subject: heading,
          text: `${heading}\n\n${row.notes ? `${row.notes}\n\n` : ''}${page}\n\nYou follow ${row.target_kind === 'app' ? row.name : row.publisher_name} on pwamart. Stop: ${config.siteUrl}/follow/unsubscribe?t=${row.token}\n`,
        });
      } else if (d.channel === 'push' && row.endpoint) {
        if (!keys) throw new Error('VAPID keys not set');
        await pushSender({ endpoint: row.endpoint, keys: row.keys }, JSON.stringify({ title: heading, body: (row.notes ?? '').slice(0, 160), url: page, icon: row.icon_url ?? '/icon-192.png', tag: `pwamart-${row.slug}` }), { keys, subject: `mailto:noreply@pwamart.com` });
        await sql`update push_subscriptions set last_ok_at = now(), failures = 0 where id = ${row.push_id}`;
      }
      sent++;
    } catch (err) {
      await sql`update release_deliveries set error = ${String(err.message).slice(0, 300)} where release_id = ${d.release_id} and follow_id = ${d.follow_id} and channel = ${d.channel}`;
      // A gone browser (404/410) is removed; anything else just counts against it.
      if (row.push_id && /\b(404|410)\b/.test(String(err.message))) await sql`delete from push_subscriptions where id = ${row.push_id}`;
      else if (row.push_id) await sql`update push_subscriptions set failures = failures + 1 where id = ${row.push_id}`;
    }
  }
  return { sent, claimed: due.length };
}

/* ------------------------------------------------------------------- rss -- */

const x = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** RSS 2.0 with an atom:self link, which feed readers and RSS Amplifier both want. */
export function rss({ title, link, self, description, items }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${x(title)}</title>
<link>${x(link)}</link>
<atom:link href="${x(self)}" rel="self" type="application/rss+xml"/>
<description>${x(description)}</description>
<language>en</language>
<generator>pwamart</generator>
${items
  .map(
    (i) => `<item>
<title>${x(i.title)}</title>
<link>${x(i.link)}</link>
<guid isPermaLink="false">${x(i.guid)}</guid>
<pubDate>${new Date(i.date).toUTCString()}</pubDate>
${i.category ? `<category>${x(i.category)}</category>` : ''}
<description>${x(i.description ?? '')}</description>
</item>`,
  )
  .join('\n')}
</channel>
</rss>
`;
}
