-- OAuth 2.1 for pwamart's own clients (CLI, TUI, stdio MCP, desktop): the tables
-- @profullstack/auth-system/oauth2/postgres expects (its OAUTH2_SCHEMA). Only
-- hashes of codes and tokens are stored.
create table if not exists oauth2_codes (
  code_hash       text primary key,
  user_id         text not null,
  client_id       text not null,
  redirect_uri    text not null,
  code_challenge  text not null,
  scope           text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create table if not exists oauth2_tokens (
  token_hash  text primary key,
  kind        text not null check (kind in ('access', 'refresh')),
  user_id     text not null,
  client_id   text not null,
  scope       text not null,
  family_id   text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists oauth2_tokens_family on oauth2_tokens (family_id);
create index if not exists oauth2_tokens_user on oauth2_tokens (user_id);
