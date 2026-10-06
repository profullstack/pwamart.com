-- A publisher proves its website the way an app proves its origin: a token in the
-- site's manifest, /.well-known/pwamart.txt, a meta tag, or a DNS TXT record.
-- `verified` stays the flag every page reads; these say how and for which domain.
alter table publishers
  add column verify_token    text,
  add column verified_by     text,          -- manifest | well-known | meta | dns | staff
  add column verified_at     timestamptz,
  add column verified_domain text;          -- the website host the proof covers

update publishers set verified_by = 'staff', verified_at = now() where verified and verified_by is null;
