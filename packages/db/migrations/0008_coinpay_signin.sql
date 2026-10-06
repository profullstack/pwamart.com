-- Sign in with CoinPay (OIDC). Accounts link on CoinPay's `sub` (the DID), never on
-- email: CoinPay does not verify emails, so matching on one would hand an existing
-- account to whoever typed that address into CoinPay.
alter table users add column coinpay_sub text;
create unique index users_coinpay_sub_key on users (coinpay_sub) where coinpay_sub is not null;
