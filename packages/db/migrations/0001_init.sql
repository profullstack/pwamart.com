-- pwamart initial schema. Orgs, org members, teams and invites come from
-- @profullstack/orgs (organizations, org_members, teams, team_members,
-- org_invites), applied first by migrate(). This file adds accounts and sign-in,
-- the plan an account is on, and the store itself: publishers, projects, apps.

-- --------------------------------------------------------------- accounts --

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table login_tokens (
  token_hash  bytea primary key,
  email       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

create table webauthn_challenges (
  id          text primary key,
  challenge   text not null,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
);

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  key_hash     bytea not null unique,
  prefix       text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ------------------------------------------------------------------ plans --
-- The plan belongs to the ACCOUNT, and its limits count everything in the orgs
-- that account owns: free = 1 publisher / 10 apps, pro ($10/yr) = 10 / 100,
-- unlimited ($199/yr) = no limits plus shared orgs, teams and projects.
-- A lapsed plan never hides a live listing; it only stops new ones.

create table account_plans (
  user_id       uuid primary key references users(id) on delete cascade,
  plan          text not null check (plan in ('pro', 'unlimited')),
  paid_through  timestamptz not null
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null,
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);

-- One row per settled payment that extended a plan: a redelivered webhook finds
-- its grant here and adds nothing.
create table plan_grants (
  payment_id  uuid primary key references payments(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  plan        text not null,
  granted_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ publishers --
-- Who an app is "by". A publisher belongs to an org; the org's members manage it.

create table publishers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  slug         text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$'),
  name         text not null,
  website      text,
  bio          text,
  avatar_url   text,
  verified     boolean not null default false, -- set by pwamart staff
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index publishers_org_idx on publishers (org_id);

-- Projects group apps inside an org (unlimited plan).
create table projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  slug        text not null,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

-- ------------------------------------------------------------------ apps --

create type app_status as enum ('draft', 'published', 'unlisted', 'removed');

create table apps (
  id              uuid primary key default gen_random_uuid(),
  publisher_id    uuid not null references publishers(id) on delete cascade,
  project_id      uuid references projects(id) on delete set null,
  slug            text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  name            text not null,
  summary         text,                 -- one line, shown on cards
  description     text,                 -- the details page, plain text
  url             text not null,        -- what was submitted (the page with the manifest link)
  origin          text not null,        -- scheme://host[:port], what domain verification covers
  start_url       text,                 -- from the manifest, resolved
  manifest_url    text,
  manifest_id     text,                 -- the manifest's id (or start_url), for navigator.install
  manifest        jsonb,
  icon_url        text,
  screenshots     jsonb not null default '[]'::jsonb,
  theme_color     text,
  background_color text,
  display         text,
  category        text not null default 'productivity',
  tags            text[] not null default '{}',
  status          app_status not null default 'draft',
  -- Ownership of the origin: a file, a meta tag or a DNS TXT record carrying the
  -- token. Unverified apps can sit in drafts but never publish.
  verify_token    text not null,
  verified_at     timestamptz,
  verified_by     text,                 -- 'well-known' | 'meta' | 'dns' | 'staff'
  check_report    jsonb,                -- the last installability inspection
  checked_at      timestamptz,
  featured        boolean not null default false,
  installs        int not null default 0,
  rating_sum      int not null default 0,
  rating_count    int not null default 0,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);
create index apps_publisher_idx on apps (publisher_id);
create index apps_listing_idx on apps (status, category);
create index apps_search_idx on apps using gin (
  to_tsvector('english', coalesce(name, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(description, ''))
);

-- One row per install click, by surface. `installs` on apps is the running count.
create table app_installs (
  id          bigserial primary key,
  app_id      uuid not null references apps(id) on delete cascade,
  method      text not null,  -- web | ios | android | desktop | cli | tui | tron | mcp | profile
  user_id     uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index app_installs_app_idx on app_installs (app_id, created_at desc);

create table reviews (
  app_id      uuid not null references apps(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  body        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (app_id, user_id)
);
