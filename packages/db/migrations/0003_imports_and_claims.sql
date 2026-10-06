-- Listings imported from other directories (saasrow.com first) and the claims that
-- hand them to their real owners. An imported publisher lives in a house org until
-- someone proves the domain with a DNS TXT record; the daemon checks pending claims
-- every 15 seconds while they are fresh, then every 30.

alter table publishers
  add column claimable    boolean not null default false,
  add column claim_domain text,
  add column source       text,
  add column source_ref   text;
create unique index publishers_source_key on publishers (source, source_ref) where source is not null;

alter table apps
  add column source     text,
  add column source_ref text;
create unique index apps_source_key on apps (source, source_ref) where source is not null;

create table publisher_claims (
  id              uuid primary key default gen_random_uuid(),
  publisher_id    uuid not null references publishers(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  domain          text not null,
  token           text not null,
  status          text not null default 'pending' check (status in ('pending', 'verified', 'expired', 'superseded')),
  checks          int not null default 0,
  last_checked_at timestamptz,
  next_check_at   timestamptz not null default now(),
  last_result     text,
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);
create unique index publisher_claims_live on publisher_claims (publisher_id, user_id) where status = 'pending';
create index publisher_claims_due on publisher_claims (next_check_at) where status = 'pending';

-- Every origin the importer looked at, so a daily run does not re-inspect the
-- whole directory: qualified ones become listings, the rest are retried weekly.
create table import_seen (
  origin      text primary key,
  source      text not null,
  source_ref  text,
  result      text not null,   -- imported | not_installable | incomplete | error | exists
  detail      text,
  checked_at  timestamptz not null default now()
);
