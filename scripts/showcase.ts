/**
 * Frames for the hqtui.com apps showcase (hqtui apps/web/scripts/app-shots.ts
 * imports this file). The listings are real pwamart.com entries from launch day,
 * frozen here (unrated, as they were) so the screenshot does not change every time
 * somebody installs or rates one.
 */
import { initialState, view } from "../packages/cli/src/tui.js";

const pub = { name: "Profullstack", verified: true };
const row = (slug: string, name: string, category_name: string, rating: number | null = null) => ({
  slug, name, category_name, rating, publisher: pub,
});

const APPS = [
  row("hqtui", "HQTUI", "Developer tools"),
  row("tronbrowser", "TronBrowser", "Utilities"),
  row("qryptchat", "QryptChat", "Communication"),
  row("typeheard", "typeheard", "AI & agents"),
  row("nixamp", "nixamp", "Music & video"),
  row("threatcrush", "ThreatCrush", "Security & privacy"),
  row("p0dcasters", "p0dcasters", "Music & video"),
  row("brisk-news", "brisk.news", "News & reading"),
  row("d3vices", "d3vices", "Utilities"),
  row("logicsrc", "LogicSRC", "Developer tools"),
  row("rss-amplifier", "RSS Amplifier", "News & reading"),
  row("coinpay", "CoinPay", "Finance & crypto"),
  row("pairux", "PairUX", "Communication"),
  row("tsbb", "tsbb", "Social"),
];

const state = {
  ...initialState({ q: "" }),
  server: "https://pwamart.com",
  list: { total: 50, apps: APPS },
  selected: 0,
  status: "50 apps · pwamart.com",
  detail: {
    app: {
      slug: "hqtui",
      name: "HQTUI",
      summary: "btop-grade terminal dashboards with a one-import API, dark by default, zero runtime dependencies.",
      description:
        "Panels, tables, graphs, trees, sparklines, modals and a status bar, laid out like flexbox and drawn with a diffing renderer. Mouse, themes, icons and emoji in six languages.",
      start_url: "https://hqtui.com/",
      rating: null,
      rating_count: 0,
      installs: 1,
      score: 75,
      verified: true,
      category_name: "Developer tools",
      publisher: pub,
      checks: [
        { level: "required", ok: true, label: "Served over HTTPS" },
        { level: "required", ok: true, label: "Links a web app manifest" },
        { level: "required", ok: true, label: "Has 192px and 512px icons" },
        { level: "required", ok: true, label: "Opens in its own window" },
      ],
    },
  },
};

export const frames = [
  {
    name: "pwamart",
    width: 140,
    height: 38,
    draw: (args: unknown) => (view(state) as (a: unknown) => void)(args),
  },
];
