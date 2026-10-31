import { describe, expect, test } from 'bun:test';
import { badgeSnippets, badgeSvg, compact, linksBack, listBadgeSvg, siteHost, siteSnippet, squareIconBadgeSvg } from '../apps/web/src/badge.js';

describe('badge', () => {
  test('siteHost: scheme, www and case do not matter; a port does', () => {
    expect(siteHost('https://www.Moshcode.sh/')).toBe('moshcode.sh');
    expect(siteHost('moshcode.sh/x?y')).toBe('moshcode.sh');
    expect(siteHost('http://localhost:3999/notes/')).toBe('localhost:3999');
    expect(siteHost('')).toBeNull();
    expect(siteHost('javascript:alert(1)')).toBeNull();
  });

  test('compact counts', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
    expect(compact(1234)).toBe('1.2k');
    expect(compact(12_345)).toBe('12k');
    expect(compact(1_500_000)).toBe('1.5M');
  });

  test('the listing badge shows rating and installs, escaped; NEW when unrated', () => {
    const svg = badgeSvg({ name: 'A <b> app', rating: 4.66, rating_count: 3, installs: 1234 });
    expect(svg).toContain('★ 4.7');
    expect(svg).toContain('1.2k installs');
    expect(svg).toContain('A &lt;b&gt; app');
    expect(svg).not.toContain('<b>');
    const fresh = badgeSvg({ name: 'x', rating: null, rating_count: 0, installs: 1 }, 'light');
    expect(fresh).toContain('NEW');
    expect(fresh).toContain('1 install<');
    expect(fresh).toContain('fill="#fff"');
    expect(listBadgeSvg()).toContain('LIST YOUR PWA FREE ON');
  });

  test('the square icon badge embeds a safe icon and falls back to the app initial', () => {
    const svg = squareIconBadgeSvg({ name: 'A <b> app' }, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    expect(svg).toContain('width="128" height="128"');
    expect(svg).toContain('aria-label="Get A &lt;b&gt; app on pwamart, square icon badge"');
    expect(svg).toContain('href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="');
    expect(svg).toContain('pwamart');
    const fallback = squareIconBadgeSvg({ name: 'No icon' }, 'https://bad.example/icon.svg');
    expect(fallback).toContain('>N</text>');
    expect(fallback).not.toContain('https://bad.example');
  });

  test('snippets', () => {
    const s = badgeSnippets({ slug: 'notes', name: 'Notes' }, 'https://pwamart.com');
    expect(s.dark.html).toBe('<a href="https://pwamart.com/apps/notes?ref=badge"><img src="https://pwamart.com/apps/notes/badge.svg" alt="Get Notes on pwamart" width="200" height="44" loading="lazy"></a>');
    expect(s.light.markdown).toBe('[![Get Notes on pwamart](https://pwamart.com/apps/notes/badge.svg?theme=light)](https://pwamart.com/apps/notes?ref=badge)');
    expect(s.square.html).toBe('<a href="https://pwamart.com/apps/notes?ref=badge"><img src="https://pwamart.com/apps/notes/icon-badge.svg" alt="Get Notes on pwamart square icon badge" width="128" height="128" loading="lazy"></a>');
    expect(s.square_light.markdown).toContain('/apps/notes/icon-badge.svg?theme=light');
    expect(siteSnippet('https://pwamart.com', 'https://moshcode.sh/')).toContain('/for.svg?site=https%3A%2F%2Fmoshcode.sh%2F');
  });

  test('linksBack: the listing or /for, never another slug or a lookalike host', () => {
    expect(linksBack('<a href="https://pwamart.com/apps/notes">', 'notes')).toBe(true);
    expect(linksBack("<a href='https://www.pwamart.com/apps/notes?ref=badge'>", 'notes')).toBe(true);
    expect(linksBack('<a href="https://pwamart.com/for?site=https%3A%2F%2Fx.com%2F">', 'notes')).toBe(true);
    expect(linksBack('<a class="x" href=https://pwamart.com/apps/notes>', 'notes')).toBe(true);
    expect(linksBack('<a href="https://pwamart.com/apps/notes-pro">', 'notes')).toBe(false);
    expect(linksBack('<a href="https://evilpwamart.com/apps/notes">', 'notes')).toBe(false);
    expect(linksBack('<img src="https://pwamart.com/apps/notes/badge.svg">', 'notes')).toBe(false);
    expect(linksBack('<a href="https://pwamart.com/forum">', 'notes')).toBe(false);
    expect(linksBack('', 'notes')).toBe(false);
  });
});
