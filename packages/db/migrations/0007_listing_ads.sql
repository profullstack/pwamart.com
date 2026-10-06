-- Every published listing gets its own CrawlProof campaign pointing at its pwamart
-- page (the daemon's listing-ads job). Featured apps keep their separate,
-- time-boxed campaign from 0005; this one is the always-on baseline.
alter table apps
  add column listing_ad_id    text,
  add column listing_ad_ref   text,
  add column listing_ad_at    timestamptz,
  add column listing_ad_error text;
create index apps_listing_ad_due on apps (published_at) where status = 'published' and listing_ad_id is null;
