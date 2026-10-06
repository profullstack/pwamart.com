/**
 * Canned posts for the Share button on a publisher page. Each click copies the
 * next one (from a random start), so a dozen people sharing the same publisher
 * do not all post the same sentence. {name}, {n} (app count), {apps} ("app" or
 * "apps"), {bio} and {url} are filled per publisher; a post that needs {bio} is
 * left out when the publisher has none. The URL always goes last, where every
 * network turns it into a card.
 */
export const PUBLISHER_POSTS = [
  '{name} has {n} web {apps} on pwamart. Install any of them on your phone or desktop, no app store needed.\n\n{url}',
  'Every web app from {name}, in one place, installable on any device:\n\n{url}',
  '{name}: {bio}\n\nAll their apps, one tap to install:\n{url}',
  'Found {name} on pwamart. {n} {apps}, all installable straight from the browser.\n\n{url}',
  'No App Store, no Play Store, no gatekeeper. Just {name}\'s apps, installed from the web:\n\n{url}',
  'If you like {name}, their whole catalog is on pwamart:\n\n{url}',
  '{bio}\n\nThat\'s {name}. Their apps install on any device from here:\n{url}',
  '{n} {apps} from {name}, each one a PWA you can put on your home screen:\n\n{url}',
  'Bookmarking this: every app {name} ships, installable on phone, tablet and desktop.\n\n{url}',
  'Web apps that install like native ones. {name} has {n} of them:\n\n{url}',
  'Follow {name} on pwamart and hear about new apps the day they launch:\n\n{url}',
  '{name} builds for the open web. Their apps, no store required:\n\n{url}',
  'Here\'s {name}\'s shelf on pwamart. Pick an app, hit Install, done.\n\n{url}',
  '{name}: {bio}\n\n{url}',
  'Install {name}\'s apps on iPhone, Android, Mac, Windows or Linux from one page:\n\n{url}',
  'One link, every {name} app:\n\n{url}',
  'Skipping the app store today. {name} ships {n} web {apps} you can install right from the browser:\n\n{url}',
  'Worth a look: {name} on pwamart.\n\n{url}',
  'Every one of {name}\'s apps installs in a tap. Have a look:\n\n{url}',
  '{name} on pwamart: {n} installable web {apps}, release notes and an RSS feed.\n\n{url}',
  'Want everything {name} makes on your home screen? Start here:\n\n{url}',
  'Small web, big apps. {name}\'s catalog:\n\n{url}',
  'Tip: {name}\'s apps are on pwamart, so you can install them without any store account.\n\n{url}',
  '{bio}\n\nSee all {n} {apps} from {name}:\n{url}',
  'Apps from {name}, straight from the source, no store cut:\n\n{url}',
  'Get notified when {name} ships something new (email, browser push or RSS):\n\n{url}',
  '{name} keeps shipping. Here\'s everything so far:\n\n{url}',
  'The {name} collection on pwamart. Every app installs from the web in seconds.\n\n{url}',
  'Not another store download. {name}\'s apps install straight from the web:\n\n{url}',
  'Sharing {name}\'s page because their apps deserve more eyes:\n\n{url}',
  '{n} reasons to check out {name}:\n\n{url}',
  'From {name}: {bio}\n\nInstall their apps here:\n{url}',
  'PWAs done right. {name} has {n} on pwamart:\n\n{url}',
  'Web apps you can actually install. {name}\'s are here:\n\n{url}',
  'Every {name} app with one Install button each:\n\n{url}',
  'Looking for good web apps? {name} has a whole shelf of them:\n\n{url}',
  'Desktop, phone, tablet: {name}\'s apps install on all of them from one page.\n\n{url}',
  '{name} on pwamart. Browse, install, follow for updates:\n\n{url}',
  'If you build for the web, look at how {name} ships:\n\n{url}',
  'Install once, get updates automatically. That\'s how {name}\'s web apps work:\n\n{url}',
  'No sign-up, no store, no waiting for review. {name}\'s apps:\n\n{url}',
  '{name} ({n} {apps}) is on pwamart:\n\n{url}',
  'Discovered {name} today. {bio}\n\n{url}',
  'Open-web apps from {name}, installable everywhere:\n\n{url}',
  'Here\'s a publisher worth following: {name}.\n\n{url}',
  'Every app {name} makes, with release notes and one-tap install:\n\n{url}',
  'Skip the store, keep the apps. {name} on pwamart:\n\n{url}',
  '{name}\'s web apps, all in one place. Install the ones you like:\n\n{url}',
  'Your next favorite app might be from {name}:\n\n{url}',
  'A whole catalog of installable web apps from {name}:\n\n{url}',
];

/** The posts for one publisher, filled in. */
export function publisherPosts({ name, bio, apps, url }) {
  const short = bio ? String(bio).replace(/\s+/g, ' ').trim().slice(0, 160).replace(/[,;:\s]+$/, '') : '';
  const fill = (t) =>
    t
      .replaceAll('{name}', name)
      .replaceAll('{n}', String(apps))
      .replaceAll('{apps}', apps === 1 ? 'app' : 'apps')
      .replaceAll('{bio}', short)
      .replaceAll('{url}', url);
  return PUBLISHER_POSTS.filter((t) => short || !t.includes('{bio}'))
    .filter((t) => (apps > 1 || !t.includes('{n} reasons')) && (apps > 0 || !t.includes('{n}')))
    .map(fill);
}
