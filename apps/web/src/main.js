import { configured, db } from '@pwamart/db';
import { migrate } from '@pwamart/db/migrate';
import { configurePayments } from '@pwamart/payments';
import { app } from './app.js';
import { config } from './config.js';

// Production never runs without its database; the deploy's health check then
// fails loudly instead of serving a store that cannot list anything.
if (process.env.NODE_ENV === 'production' && !configured())
  throw new Error('DATABASE_URL is not set (it comes from the vault via deploy-app.sh)');

// Migrations run on every boot, before the server listens, so no deploy skips one.
if (configured()) {
  await migrate();
  // The coinpay object goes in whole: its getters read the environment on each access.
  configurePayments({ sql: db(), coinpay: config.coinpay, siteUrl: config.siteUrl });
}

const port = Number(process.env.PORT || 3000);
const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 30 });
console.log(
  `[web] pwamart listening on :${server.port} · site ${config.siteUrl} · mail ${config.mail.enabled ? 'on' : 'off'} · payments ${config.coinpay.enabled ? 'on' : 'off'}`,
);
