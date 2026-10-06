-- Get featured for $19 (CoinPay): a week on the home page and the next newsletter issue.
-- And the newsletter itself: double opt-in subscribers, issues, one delivery row per send.

-- A paid feature runs out; a staff pick (featured_until null) does not.
alter table apps add column if not exists featured_until timestamptz;

-- One row per paid feature, keyed on the payment, so a replayed webhook grants nothing twice.
create table if not exists featured_slots (
  payment_id uuid primary key references payments(id) on delete cascade,
  app_id     uuid not null references apps(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz not null,
  issue_id   uuid,                       -- the newsletter issue it ran in; null = still owed one
  created_at timestamptz not null default now()
);
create index if not exists featured_slots_owed on featured_slots (created_at) where issue_id is null;

create table if not exists newsletter_subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  token           text not null unique,  -- confirm + unsubscribe link secret
  source          text,
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists newsletter_subscribers_email on newsletter_subscribers (lower(email));

create table if not exists newsletter_issues (
  id         uuid primary key default gen_random_uuid(),
  subject    text not null,
  body       text not null,              -- plain text; the unsubscribe line is added per subscriber
  status     text not null default 'draft' check (status in ('draft', 'sending', 'sent')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  queued_at  timestamptz,
  sent_at    timestamptz
);

alter table featured_slots drop constraint if exists featured_slots_issue_fk;
alter table featured_slots add constraint featured_slots_issue_fk foreign key (issue_id) references newsletter_issues(id) on delete set null;

-- Claimed before the email goes out: a failed send is not retried, which beats sending twice.
create table if not exists newsletter_deliveries (
  issue_id      uuid not null references newsletter_issues(id) on delete cascade,
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  sent_at       timestamptz not null default now(),
  error         text,
  primary key (issue_id, subscriber_id)
);
