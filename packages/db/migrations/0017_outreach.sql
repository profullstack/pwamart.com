-- Weekly engagement outreach (apps/web/src/outreach.js): one email a week at most
-- per address, bundling every nudge that applies to it.
--   * unclaimed publishers: "claim your listing for free", to the address the
--     listing was submitted with on the source directory (saasrow submission_contacts,
--     copied in by bin/sync-saasrow-contacts.sh)
--   * owners: badge, drafts, empty profile, unspent karma credit, unanswered
--     comments, with the week's installs and upvotes as the hook

alter table publishers add column if not exists contact_email text;

-- One row per address ever emailed: the unsubscribe token, and the opt-out.
create table if not exists outreach_recipients (
  email           text primary key,          -- lower-cased
  token           text not null unique,
  opted_out_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- One row per digest sent. `kinds` lists the nudges it carried, so each kind can be
-- capped (claim 8 times, badge 6, ...) and the weekly gap enforced per address.
create table if not exists outreach_sends (
  id         bigserial primary key,
  email      text not null,
  kinds      text[] not null,
  subject    text not null,
  sent_at    timestamptz not null default now()
);
create index if not exists outreach_sends_email_idx on outreach_sends (email, sent_at desc);
