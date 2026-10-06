import { createHash } from 'node:crypto';
import { safeFetch } from './inspect.js';

/**
 * iOS one-tap install: a configuration profile carrying Web Clip payloads.
 * Opening it on an iPhone offers "Profile Downloaded"; installing it in Settings
 * puts each app's icon on the home screen, opening full screen like Add to Home
 * Screen does. One profile can carry many apps (the bundle route).
 *
 * The profile is unsigned until PROFILE_SIGNING is set up, so iOS labels it
 * "Unverified"; it still installs. Icons must be PNG or JPEG: iOS ignores SVG.
 */

const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A stable UUID from a string, so re-downloading replaces rather than duplicates. */
function uuidFrom(s) {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

async function iconData(url) {
  if (!url) return null;
  try {
    const r = await safeFetch(url, { accept: 'image/png,image/jpeg', maxBytes: 1024 * 1024 });
    const png = r.bytes[0] === 0x89 && r.bytes[1] === 0x50;
    const jpg = r.bytes[0] === 0xff && r.bytes[1] === 0xd8;
    return r.status < 400 && (png || jpg) ? r.bytes.toString('base64') : null;
  } catch {
    return null;
  }
}

export async function buildProfile(apps, { siteUrl }) {
  const payloads = [];
  for (const a of apps) {
    const data = await iconData(a.icon_url ?? a.icon);
    payloads.push(`    <dict>
      <key>PayloadType</key><string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.pwamart.webclip.${xml(a.slug)}</string>
      <key>PayloadUUID</key><string>${uuidFrom(`clip:${a.slug}`)}</string>
      <key>PayloadDisplayName</key><string>${xml(a.name)}</string>
      <key>Label</key><string>${xml(String(a.name).slice(0, 32))}</string>
      <key>URL</key><string>${xml(a.start_url ?? a.url)}</string>
      <key>FullScreen</key><true/>
      <key>IsRemovable</key><true/>
      <key>IgnoreManifestScope</key><false/>
      <key>Precomposed</key><true/>${data ? `\n      <key>Icon</key><data>${data}</data>` : ''}
    </dict>`);
  }
  const id = apps.map((a) => a.slug).sort().join(',');
  const name = apps.length === 1 ? apps[0].name : `${apps.length} apps`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>com.pwamart.profile.${uuidFrom(id).slice(0, 8).toLowerCase()}</string>
  <key>PayloadUUID</key><string>${uuidFrom(`profile:${id}`)}</string>
  <key>PayloadDisplayName</key><string>${xml(name)} (pwamart)</string>
  <key>PayloadDescription</key><string>${xml(`Adds ${name} to your Home Screen. From ${siteUrl}.`)}</string>
  <key>PayloadOrganization</key><string>pwamart</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadContent</key>
  <array>
${payloads.join('\n')}
  </array>
</dict>
</plist>
`;
}
