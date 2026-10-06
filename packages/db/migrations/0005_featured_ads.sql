-- Every paid feature also gets a free campaign on the CrawlProof ad network for its
-- week. The daemon creates it after the payment settles (creating writes the
-- creatives, too slow for the webhook) and pauses it when the feature ends.
--
-- ad_status: null = not started, 'active', 'paused', 'existing' (CrawlProof already
-- ran a live campaign for that URL: used, never paused by us), 'failed' (gave up).
alter table featured_slots add column if not exists ad_campaign_id  text;
alter table featured_slots add column if not exists ad_campaign_ref text;
alter table featured_slots add column if not exists ad_status       text;
alter table featured_slots add column if not exists ad_attempts     int not null default 0;
alter table featured_slots add column if not exists ad_error        text;
create index if not exists featured_slots_ad_todo on featured_slots (created_at) where ad_campaign_id is null;
