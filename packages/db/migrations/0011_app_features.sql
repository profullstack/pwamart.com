-- What an app can do, as detected by the inspector, so the store can filter by it.
-- Generic on purpose: 'offline' first (a service worker that answers from a cache),
-- later features are more strings in the same array.
alter table apps
  add column features            text[] not null default '{}',
  add column offline_reason      text,          -- workbox | fetch+cache | no service worker | no fetch handler | ...
  add column features_checked_at timestamptz;   -- null: never inspected for features (the daemon backfills these)

create index apps_features_gin on apps using gin (features);
