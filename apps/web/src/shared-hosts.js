/**
 * Hosting platforms that hand every customer a subdomain of their own domain.
 * Whoever deploys to `you.vercel.app` does not control its DNS (Vercel does), so a
 * TXT record can never be the proof there: the app's own file, meta tag or
 * manifest is. A curated list rather than the whole Public Suffix List, which is
 * mostly country registries that change nothing here.
 */
export const SHARED_HOSTS = [
  'github.io',
  'gitlab.io',
  'codeberg.page',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'up.railway.app',
  'deno.dev',
  'glitch.me',
  'surge.sh',
  'replit.app',
  'repl.co',
  'amplifyapp.com',
  'azurestaticapps.net',
  'azurewebsites.net',
  'appspot.com',
  'ngrok.app',
  'ngrok-free.app',
  'trycloudflare.com',
  'neocities.org',
  'webflow.io',
  'framer.app',
  'bubbleapps.io',
  'lovable.app',
  'bolt.host',
  'stackblitz.io',
];

/** The platform suffix a hostname sits under, or null for a domain of its own. */
export function sharedHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return SHARED_HOSTS.find((s) => h === s || h.endsWith(`.${s}`)) ?? null;
}
