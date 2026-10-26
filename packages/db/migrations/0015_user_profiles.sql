-- The shared Profullstack profile: email, first_name, last_name, company_domain,
-- job_title, linkedin_url, owned by @profullstack/profile.
--
-- The package's own table, keyed by users.id, so `profile export` and the store
-- work here with no options. DDL is `profile schema --key user_id --key-type uuid`
-- output. No foreign key, as the package documents; deleting a user is the host's job.
-- No backfill: users.name holds only the "Unclaimed listings" system account, not a person.
create table if not exists "user_profiles" (
  "user_id" uuid primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on "user_profiles" (lower("email"));
create index if not exists "user_profiles_company_domain" on "user_profiles" ("company_domain");

-- The account row is only created when the emailed link is spent, so the fields a
-- signup typed ride on the token until then. Validated before they are stored here,
-- and saved only once the link proves the mailbox: nobody can put a name on somebody
-- else's address by requesting a link for it.
alter table login_tokens add column if not exists profile jsonb;
