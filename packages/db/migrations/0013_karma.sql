-- Karma: upvotes, comments and shares on app pages, one append-only points ledger,
-- free Featured-week credits every KARMA_PER_CREDIT points, and the badges table the
-- @profullstack/leaderboard package keeps (its board is a projection of the ledger).

-- ------------------------------------------------------------------ votes --
-- One upvote per member per app. `apps.votes` is the running count (the "Top voted" sort).
alter table apps add column if not exists votes int not null default 0;

create table if not exists app_votes (
  app_id     uuid not null references apps(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (app_id, user_id)
);
create index if not exists app_votes_user_idx on app_votes (user_id, created_at desc);
create index if not exists apps_votes_idx on apps (votes desc) where status = 'published';

-- --------------------------------------------------------------- comments --
-- One level of replies: a reply's parent is always a top-level comment. Deleting is
-- soft, so a thread keeps its shape; a deleted body is never rendered.
create table if not exists app_comments (
  id          uuid primary key default gen_random_uuid(),
  app_id      uuid not null references apps(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  parent_id   uuid references app_comments(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references users(id) on delete set null
);
create index if not exists app_comments_app_idx on app_comments (app_id, created_at);
create index if not exists app_comments_user_idx on app_comments (user_id, created_at desc);

-- ---------------------------------------------------------------- ledger --
-- Never updated. A member's karma is sum(points); a reversal is a new negative row.
-- The unique key is the dedupe: a retry or a double click never pays twice.
--   bucket ''          once ever (publish, review, vote, verify, received_*)
--   bucket 'YYYY-MM-DD' once a day (share)
--   bucket 'reversed'  the one reversal of a row
create table if not exists karma_events (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  action      text not null,
  ref         text not null,
  bucket      text not null default '',
  points      int not null,
  app_id      uuid references apps(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (user_id, action, ref, bucket)
);
create index if not exists karma_events_user_idx on karma_events (user_id, created_at desc);
create index if not exists karma_events_at_idx on karma_events (created_at);

-- One free Featured week per crossed milestone (milestone n = n * KARMA_PER_CREDIT
-- karma), granted once even if karma later dips. Spending it runs the same grant as a
-- paid feature, through a zero-amount `payments` row (provider 'karma').
create table if not exists karma_credits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  milestone   int not null,
  granted_at  timestamptz not null default now(),
  spent_at    timestamptz,
  app_id      uuid references apps(id) on delete set null,
  payment_id  uuid references payments(id) on delete set null,
  unique (user_id, milestone)
);

-- A featured slot paid with a karma credit, not CoinPay.
alter table featured_slots add column if not exists paid_with text not null default 'coinpay';

-- @profullstack/leaderboard's badge store (sqlStore, prefix lb_): badges are awarded,
-- not derived, so they need a home. Its events/gauges tables are not used: the board
-- reads karma_events.
create table if not exists lb_badges (
  player text not null,
  badge  text not null,
  at     bigint not null,
  primary key (player, badge)
);
