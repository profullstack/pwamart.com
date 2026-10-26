-- Credit codes and invites (apps/web/src/credits.js).
--
-- The code and invite tables themselves (credit_*, aff_*) belong to
-- @profullstack/redeem-credits and @profullstack/affiliates, which create them
-- on first use. A redeemed code or an invite bonus is Pro time, and Pro time
-- only ever comes from plan_periods: each grant is a zero-amount `payments` row
-- (provider 'grant', provider_ref '<source>:<user id>', so the unique key makes
-- it idempotent per user and source) plus its plan_grants row and one period.

-- An invite or ?ref= picked up before sign-in rides the emailed link, so opening
-- the link on another browser or phone still counts.
alter table login_tokens add column if not exists invite_code text;
alter table login_tokens add column if not exists ref_code text;

-- One row per person per accepted invite: what the invite paid, or why not.
-- Claimed before the grant, so a retried sign-in never pays twice.
create table if not exists invite_bonuses (
  invite_id  text not null,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('inviter', 'invitee')),
  days       int not null default 0,
  status     text not null,
  created_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);
-- An account is invited once, whatever the invite package allowed before 0.3.
create unique index if not exists invite_bonuses_one_invitee on invite_bonuses (user_id) where role = 'invitee';
create index if not exists invite_bonuses_inviter_recent on invite_bonuses (user_id, created_at) where role = 'inviter';
