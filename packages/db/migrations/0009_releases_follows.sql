-- Releases ("what's new") and following: a person follows a listing or a publisher
-- and hears about its releases (and, for a publisher, its new apps) by email,
-- browser push, or both. RSS feeds read the same rows.

create table app_releases (
  id          uuid primary key default gen_random_uuid(),
  app_id      uuid not null references apps(id) on delete cascade,
  kind        text not null check (kind in ('launched', 'publisher', 'detected')),
  version     text,
  title       text not null,
  notes       text,
  changes     jsonb not null default '[]'::jsonb,   -- detected: which manifest fields changed
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  notified_at timestamptz                              -- deliveries queued
);
create index app_releases_app_idx on app_releases (app_id, created_at desc);
create index app_releases_recent_idx on app_releases (created_at desc);
create index app_releases_pending_idx on app_releases (created_at) where notified_at is null;

-- Fingerprint of the manifest fields worth announcing; the daemon compares it daily.
alter table apps add column manifest_hash text, add column manifest_fields jsonb, add column release_checked_at timestamptz;

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique,
  keys        jsonb not null,
  user_id     uuid references users(id) on delete set null,
  failures    int not null default 0,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);

-- One follower of one listing or publisher. Channels: the account's email (user_id),
-- a bare email (double opt-in: confirmed_at), and/or one browser (push_id).
create table follows (
  id            uuid primary key default gen_random_uuid(),
  target_kind   text not null check (target_kind in ('app', 'publisher')),
  target_id     uuid not null,
  user_id       uuid references users(id) on delete cascade,
  email         text,
  push_id       uuid references push_subscriptions(id) on delete set null,
  token         text not null unique,      -- confirm + one-click unsubscribe
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  check (user_id is not null or email is not null or push_id is not null)
);
create unique index follows_user_key on follows (target_kind, target_id, user_id) where user_id is not null;
create unique index follows_email_key on follows (target_kind, target_id, lower(email)) where email is not null and user_id is null;
create unique index follows_push_key on follows (target_kind, target_id, push_id) where push_id is not null and user_id is null and email is null;
create index follows_target_idx on follows (target_kind, target_id);

-- One delivery per release, follower and channel; claimed before it is sent.
create table release_deliveries (
  release_id  uuid not null references app_releases(id) on delete cascade,
  follow_id   uuid not null references follows(id) on delete cascade,
  channel     text not null check (channel in ('email', 'push')),
  sent_at     timestamptz,
  error       text,
  primary key (release_id, follow_id, channel)
);
create index release_deliveries_due on release_deliveries (release_id) where sent_at is null and error is null;
