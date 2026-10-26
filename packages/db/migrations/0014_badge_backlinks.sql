-- The embeddable badge (/apps/<slug>/badge.svg, /for.svg?site=): a listing whose
-- homepage links back to pwamart is badge-verified, which earns the ✓ on its page
-- and a followed website link. The daemon re-checks; removing the badge clears it.
alter table apps
  add column if not exists badge_verified_at timestamptz,
  add column if not exists badge_checked_at  timestamptz;  -- null: never checked (the daemon backfills these)

create index if not exists apps_badge_due_idx on apps (badge_checked_at nulls first) where status = 'published';
