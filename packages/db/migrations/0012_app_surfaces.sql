-- Every listing is a PWA; some are also a CLI, an HTTP API or an MCP server.
-- `surfaces` is what the detector found on the app's origin (and in the w3bs
-- package catalog); `surfaces_set` is what the publisher said, which wins key by
-- key (a key set to false hides a detected surface). `surface_keys` is the merged
-- answer, written alongside either, so the store can filter on it.
alter table apps
  add column surfaces            jsonb  not null default '{}'::jsonb,
  add column surfaces_set        jsonb  not null default '{}'::jsonb,
  add column surface_keys        text[] not null default '{}',
  add column surfaces_checked_at timestamptz;   -- null: never probed (the daemon backfills these)

create index apps_surface_keys_gin on apps using gin (surface_keys);
