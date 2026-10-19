/**
 * The pit.world network footer, fetched server-side from pit.world/snippets.
 * It sits under the store's own footer, as the last thing in <body>.
 *
 * The page templates are synchronous, so a middleware calls refreshFooter()
 * before the handlers run and the pages read the last fetched string. Only the
 * very first fetch is awaited (3 s timeout); after that a copy older than an
 * hour refreshes in the background and a failed fetch keeps the stale copy.
 * With no copy at all the network footer is simply left out.
 */
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=pwamart.com';
const TTL_MS = 60 * 60 * 1000;

let current = '';
let fetchedAt = 0;
let inflight = null;
let first = true;

function fetchPit() {
  inflight ??= fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`pit footer ${res.status}`);
      const text = await res.text();
      if (!text.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
      current = text;
      fetchedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const siteFooter = () => current;

export async function refreshFooter() {
  if (Date.now() - fetchedAt < TTL_MS) return;
  const p = fetchPit();
  if (first) {
    first = false;
    await p;
  }
}
