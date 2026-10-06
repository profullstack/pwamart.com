import Anthropic from '@anthropic-ai/sdk';
import { InspectError, listingName, pickIcon, readHead, safeFetch } from './inspect.js';

/**
 * "Fill from website" for a publisher: read the site the way the inspector reads
 * an app (same SSRF guard, https only) and suggest a name, a logo and a bio. Nothing
 * is saved here; the console fills the form and the publisher presses Save.
 *
 * The logo is the best square mark the site publishes: the largest manifest icon,
 * then the apple-touch-icon, then an SVG or PNG favicon, then og:image (usually a
 * wide banner, so last). The bio is the site's own description; only when the site
 * has none does Claude write one from the page text, and without ANTHROPIC_API_KEY
 * (or when the call fails) the bio is left for the publisher to write.
 */

const MODEL = 'claude-opus-5-5';

export async function fetchProfile(rawUrl, { writeBio = aiBio } = {}) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(String(rawUrl).trim()) ? String(rawUrl).trim() : `https://${String(rawUrl).trim()}`);
  } catch {
    throw new InspectError('that is not a URL');
  }
  const page = await safeFetch(url.href, { accept: 'text/html,application/xhtml+xml' });
  if (page.status >= 400) throw new InspectError(`${url.href} answered HTTP ${page.status}`);
  const finalUrl = new URL(page.url);
  const head = readHead(page.text, finalUrl);

  let manifest = null;
  if (head.manifest) {
    try {
      const m = await safeFetch(head.manifest, { accept: 'application/manifest+json,application/json', maxBytes: 512 * 1024 });
      if (m.status < 400) {
        manifest = JSON.parse(m.text.replace(/^﻿/, ''));
        const base = new URL(m.url);
        manifest.icons = (Array.isArray(manifest.icons) ? manifest.icons : [])
          .map((i) => {
            try {
              return { ...i, src: new URL(i.src, base).href };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch {
      manifest = null;
    }
  }

  const logo = pickLogo({ manifest, head });
  const name = listingName(head.siteName || manifest?.name || head.title || finalUrl.hostname.replace(/^www\./, ''), manifest?.short_name);
  let bio = clean(manifest?.description || head.description);
  let bioSource = bio ? 'site' : null;
  if (!bio) {
    bio = await writeBio({ name, url: finalUrl.href, title: head.title, text: pageText(page.text) }).catch(() => null);
    if (bio) bioSource = 'ai';
  }
  return {
    name,
    website: finalUrl.origin,
    logo: logo?.src ?? null,
    logo_source: logo?.from ?? null,
    bio: bio ? bio.slice(0, 1000) : null,
    bio_source: bioSource,
  };
}

/** The best square mark the site publishes, and where it came from. */
export function pickLogo({ manifest, head }) {
  const icon = pickIcon(manifest?.icons ?? [], 128);
  if (icon?.src) return { src: icon.src, from: 'manifest' };
  if (head.appleIcon) return { src: head.appleIcon, from: 'apple-touch-icon' };
  const fav = head.icons.find((i) => /\.svg(\?|$)/i.test(i)) ?? head.icons.find((i) => /\.png(\?|$)/i.test(i)) ?? head.icons[0];
  if (fav) return { src: fav, from: 'favicon' };
  if (head.ogImage) return { src: head.ogImage, from: 'og:image' };
  return null;
}

const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() || null : null);

/** The page's readable text, for a bio when the site has no description of its own. */
export function pageText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

let client = null;

/** One or two sentences about the publisher, from its own page text. Null without a key. */
export async function aiBio({ name, url, title, text }) {
  if (!process.env.ANTHROPIC_API_KEY || !text) return null;
  client ??= new Anthropic();
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system:
        'You write the short "about" line for a publisher profile in a web app store. Use only facts stated in the page text you are given. ' +
        'Write one or two plain sentences, at most 240 characters, in the third person, with no marketing superlatives, no em dashes and no quotation marks. ' +
        'If the page text does not say what the publisher makes, answer with exactly: UNKNOWN',
      messages: [
        {
          role: 'user',
          content: `Publisher: ${name}\nWebsite: ${url}\nPage title: ${title ?? ''}\n\n<page_text>\n${text}\n</page_text>`,
        },
      ],
    });
    if (res.stop_reason === 'refusal') return null;
    const out = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!out || out === 'UNKNOWN') return null;
    return out.replace(/\s+/g, ' ').slice(0, 300);
  } catch (err) {
    // Logged verbatim: a capped or revoked key otherwise fails silently fleet-wide.
    console.error(`[profile] bio: ${err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err.message}`);
    return null;
  }
}
