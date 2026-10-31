/**
 * PwaMart's single footer comes from the shared @profullstack/footer template.
 * Keep a bundled copy ready for the first request, then refresh the shared
 * template in the background through the package's cache. Publishing one
 * template updates every site that uses this module without another code edit.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

const OPTIONS = {
  site: 'https://pwamart.com/',
  since: 2026,
  links: [
    { label: 'Browse apps', href: '/apps' },
    { label: 'Collections', href: '/collections' },
    { label: 'Publishers', href: '/publishers' },
    { label: 'Developers', href: '/developers' },
    { label: 'API', href: '/developers#api' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Advertise', href: '/advertise' },
    { label: 'Karma', href: '/leaderboard' },
    { label: 'Newsletter', href: '/newsletter' },
    { label: 'llms.txt', href: '/llms.txt' },
    { label: 'PwaMart on GitHub', href: 'https://github.com/profullstack/pwamart.com', rel: 'noopener noreferrer' },
  ],
  pwamartHref: 'https://pwamart.com/for?site=https://pwamart.com/',
  builtIndieHref: 'https://built.indie.pit.world/for?site=https://pwamart.com/',
};

let current = footerHtmlSync(OPTIONS);
let inflight = null;

export const siteFooter = () => current;

export async function refreshFooter() {
  if (inflight) return inflight;
  inflight = footerHtml(OPTIONS)
    .then((html) => {
      if (html.includes('data-pfs-footer=')) current = html;
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
