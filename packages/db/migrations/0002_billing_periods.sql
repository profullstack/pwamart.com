-- Billing as paid periods. Payment is prepaid crypto, so nothing is ever charged
-- on its own: a plan is the set of periods someone has paid for. One row per
-- paid year makes every change exact: an upgrade ends the Pro period now and
-- starts Unlimited; a renewal or a prepaid downgrade queues a period after the
-- last one; cancelling just means "do not remind me to renew".

create table plan_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  plan        text not null check (plan in ('pro', 'unlimited')),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  payment_id  uuid unique references payments(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index plan_periods_user_idx on plan_periods (user_id, ends_at);

-- What happens when the paid time runs out. renew = the plan the reminders ask
-- for; 'none' = cancelled (the plan runs to its end, then the account is free).
create table account_billing (
  user_id      uuid primary key references users(id) on delete cascade,
  renew        text not null default 'same' check (renew in ('same', 'pro', 'unlimited', 'none')),
  canceled_at  timestamptz,
  updated_at   timestamptz not null default now()
);

-- One reminder per kind per period end, so a restart never sends twice.
create table renewal_notices (
  user_id     uuid not null references users(id) on delete cascade,
  period_end  timestamptz not null,
  kind        text not null check (kind in ('14d', '3d', 'ended')),
  sent_at     timestamptz not null default now(),
  primary key (user_id, period_end, kind)
);

-- Carry over anything bought under the one-row model.
insert into plan_periods (user_id, plan, starts_at, ends_at)
  select user_id, plan, paid_through - interval '1 year', paid_through from account_plans;
drop table account_plans;
