import { describe, expect, test } from 'bun:test';
import { app } from '../apps/web/src/app.js';
import { privacyPage, termsPage } from '../apps/web/src/legal.js';

const BROWSER = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
};

describe('legal pages', () => {
  for (const [path, heading] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
    test(`${path} renders server-side with its heading, no ad, and the footer links`, async () => {
      const res = await app.request(path, { headers: BROWSER });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).toContain(`<title>${heading} · pwamart</title>`);
      expect(html).toContain('Effective date: November 11, 2026');
      expect(html).not.toContain('data-cp-ad');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
    });
  }

  test('privacy has the AI agents and MCP section', () => {
    const html = privacyPage();
    expect(html).toContain('AI agents and MCP');
    expect(html).toContain('/mcp</code>');
  });

  test('no em or en dashes in the legal copy', () => {
    for (const html of [privacyPage(), termsPage()]) {
      const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
      expect(main.length).toBeGreaterThan(1000);
      expect(main).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
