import { db } from '@pwamart/db';
import { MIN_COMMENT_CHARS, MIN_REVIEW_CHARS, SHARE_NETWORKS, award, dayOf, ownerOf, ownsApp, playerId, reverse } from './karma.js';

/**
 * Upvotes, comments and tracked shares on app pages, and the karma each pays.
 * `app` is a catalog row (getApp): it carries id and publisher_id.
 */

/* ----------------------------------------------------------------- votes -- */

export async function voteState(app, user) {
  const [v] = user ? await db()`select 1 as one from app_votes where app_id = ${app.id} and user_id = ${user.id}` : [];
  const [{ votes }] = await db()`select votes from apps where id = ${app.id}`;
  return { voted: Boolean(v), votes, signed_in: Boolean(user) };
}

/**
 * Upvote (idempotent). Pays the voter +1 and the app's owner +1, unless the voter
 * is in the org that publishes it. Taking a vote back does not undo what was paid,
 * and voting again pays nothing more (the ledger already holds that row).
 */
export async function upvote(app, user) {
  const fresh = await db().begin(async (tx) => {
    const [row] = await tx`insert into app_votes (app_id, user_id) values (${app.id}, ${user.id}) on conflict do nothing returning app_id`;
    if (row) await tx`update apps set votes = votes + 1 where id = ${app.id}`;
    return Boolean(row);
  });
  const karma = fresh ? await payVote(app, user) : null;
  return { ...(await voteState(app, user)), karma };
}

async function payVote(app, user) {
  if (await ownsApp(user.id, app.publisher_id)) return { paid: false, reason: 'your own app' };
  const r = await award({ userId: user.id, action: 'vote', ref: app.id, appId: app.id });
  const owner = await ownerOf(app.publisher_id);
  if (owner && owner !== user.id) await award({ userId: owner, action: 'received_vote', ref: `${app.id}:${user.id}`, appId: app.id });
  return r;
}

export async function unvote(app, user) {
  await db().begin(async (tx) => {
    const [row] = await tx`delete from app_votes where app_id = ${app.id} and user_id = ${user.id} returning app_id`;
    if (row) await tx`update apps set votes = greatest(votes - 1, 0) where id = ${app.id}`;
  });
  return voteState(app, user);
}

/* --------------------------------------------------------------- reviews -- */

/** After a review is saved: the reviewer's +5 (30+ chars, once) and, on a new review, the owner's +2. */
export async function payReview(app, user, { body, isNew }) {
  if (await ownsApp(user.id, app.publisher_id)) return { paid: false, reason: 'your own app' };
  const r =
    String(body ?? '').trim().length >= MIN_REVIEW_CHARS
      ? await award({ userId: user.id, action: 'review', ref: app.id, appId: app.id })
      : { paid: false, reason: `reviews earn karma from ${MIN_REVIEW_CHARS} characters` };
  if (isNew) {
    const owner = await ownerOf(app.publisher_id);
    if (owner && owner !== user.id) await award({ userId: owner, action: 'received_review', ref: `${app.id}:${user.id}`, appId: app.id });
  }
  return r;
}

/* -------------------------------------------------------------- comments -- */

export const COMMENT_MAX = 2000;
export const COMMENT_RATE = { perMinute: 5, perDay: 60 };

const commentShape = (r, user) => ({
  id: r.id,
  parent_id: r.parent_id,
  body: r.deleted_at ? null : r.body,
  deleted: Boolean(r.deleted_at),
  author: r.deleted_at ? null : r.author,
  player: r.deleted_at ? null : playerId(r.user_id),
  karma: r.deleted_at ? null : r.karma,
  created_at: r.created_at,
  ...(user ? { mine: r.user_id === user.id, can_delete: !r.deleted_at && (r.user_id === user.id || Boolean(user.is_admin)) } : {}),
});

/**
 * An app's comments, oldest first, replies under their parent. A deleted comment
 * shows only while a reply still hangs off it.
 */
export async function commentsFor(appId, user = null) {
  const rows = await db()`
    select c.id, c.parent_id, c.user_id, c.body, c.created_at, c.deleted_at,
           coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) as author,
           (select coalesce(sum(k.points), 0) from karma_events k where k.user_id = c.user_id)::int as karma
    from app_comments c join users u on u.id = c.user_id
    where c.app_id = ${appId} order by c.created_at limit 500`;
  const live = new Set(rows.filter((r) => !r.deleted_at).map((r) => r.parent_id).filter(Boolean));
  const top = rows.filter((r) => !r.parent_id && (!r.deleted_at || live.has(r.id)));
  return top.map((r) => ({
    ...commentShape(r, user),
    replies: rows.filter((x) => x.parent_id === r.id && !x.deleted_at).map((x) => commentShape(x, user)),
  }));
}

export class CommentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function addComment(app, user, { body, parent }) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length < 2) throw new CommentError(400, 'write a comment first');
  if (text.length > COMMENT_MAX) throw new CommentError(400, `comments are at most ${COMMENT_MAX} characters`);
  const sql = db();
  const [rate] = await sql`select count(*) filter (where created_at > now() - interval '1 minute')::int as minute,
                                  count(*) filter (where created_at > now() - interval '1 day')::int as day
                           from app_comments where user_id = ${user.id}`;
  if (rate.minute >= COMMENT_RATE.perMinute || rate.day >= COMMENT_RATE.perDay)
    throw new CommentError(429, 'slow down: too many comments, try again in a minute');
  let parentId = null;
  if (parent) {
    const [p] = await sql`select id, parent_id from app_comments where id::text = ${String(parent)} and app_id = ${app.id} and deleted_at is null`;
    if (!p) throw new CommentError(404, 'no such comment to reply to');
    parentId = p.parent_id ?? p.id; // one level: a reply to a reply joins the same thread
  }
  const [c] = await sql`insert into app_comments (app_id, user_id, parent_id, body) values (${app.id}, ${user.id}, ${parentId}, ${text}) returning id`;
  let karma;
  if (text.length < MIN_COMMENT_CHARS) karma = { paid: false, reason: `comments earn karma from ${MIN_COMMENT_CHARS} characters` };
  else if (await ownsApp(user.id, app.publisher_id)) karma = { paid: false, reason: 'your own app' };
  else karma = await award({ userId: user.id, action: 'comment', ref: c.id, appId: app.id });
  return { id: c.id, parent_id: parentId, karma };
}

/** The author or staff. Soft delete; the comment's karma goes back. */
export async function deleteComment(id, user) {
  const sql = db();
  const [c] = await sql`select id, user_id, deleted_at from app_comments where id::text = ${String(id)}`;
  if (!c || c.deleted_at) throw new CommentError(404, 'no such comment');
  if (c.user_id !== user.id && !user.is_admin) throw new CommentError(404, 'no such comment');
  await sql`update app_comments set deleted_at = now(), deleted_by = ${user.id} where id = ${c.id} and deleted_at is null`;
  const r = await reverse({ userId: c.user_id, action: 'comment', ref: c.id });
  return { deleted: true, karma_reversed: r.reversed ? r.points : 0 };
}

/* ---------------------------------------------------------------- shares -- */

/** A share-button click. Anonymous clicks are fine and earn nothing. */
export async function share(app, user, network) {
  const net = String(network ?? '').toLowerCase();
  if (!SHARE_NETWORKS.includes(net)) return { ok: true, network: net, karma: { paid: false, reason: 'not a tracked network' } };
  if (!user) return { ok: true, network: net, karma: { paid: false, reason: 'sign in to earn karma for sharing' } };
  if (await ownsApp(user.id, app.publisher_id)) return { ok: true, network: net, karma: { paid: false, reason: 'your own app' } };
  const karma = await award({ userId: user.id, action: 'share', ref: `${app.id}:${net}`, bucket: dayOf(), appId: app.id });
  return { ok: true, network: net, karma };
}
