/**
 * apple-music.jsh — Apple Music CLI for SLICC
 *
 * Manages Apple Music library and catalog operations via the Apple Music web API.
 * Uses page-context fetch (via the `sliccy:browser` bridge) to handle authentication.
 *
 * Usage:
 *   apple-music search <query> [--type songs|albums|artists|playlists] [--limit N]
 *   apple-music playlists
 *   apple-music playlist <id>
 *   apple-music create-playlist <name> [--description "..."]
 *   apple-music edit-playlist <id> [--name "..."] [--description "..."]
 *   apple-music delete-playlist <id>
 *   apple-music add-tracks <playlistId> <catalogSongId> [catalogSongId2] ...
 *   apple-music remove-track <playlistId> <librarySongId>
 *   apple-music reorder <playlistId> <libSongId1> [libSongId2] ...
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ MIGRATION NOTES (issue #118 / ai-ecoverse/slicc#786)                        │
 * │                                                                             │
 * │ The .jsh runtime no longer injects bare globals (`exec`, `fmt`, `cli`,      │
 * │ ...) — they must be pulled in explicitly via require('sliccy:<name>').     │
 * │ This script's logic is otherwise unchanged; only the following moved:      │
 * │                                                                             │
 * │  • const fmt  = require('sliccy:fmt');   — replaces the hand-rolled       │
 * │    col()/pad() helper with fmt.col(str, width) (same signature/behavior). │
 * │                                                                             │
 * │  • Tab discovery/open + in-page fetch: previously shelled out to          │
 * │    `playwright-cli tab-list` / `tab-new` / `eval` via the bare `exec()`   │
 * │    global and regex-parsed the CLI output (including a fragile           │
 * │    double-JSON-decode of the eval return value). Replaced with the        │
 * │    dedicated `sliccy:browser` bridge: `browser.findTab({ domain })`,      │
 * │    `browser.ensureTab(url)`, `browser.eval(tab, fn)`/`evalAsync`, and     │
 * │    `browser.fetch(tab, url, opts)` for the authenticated API calls        │
 * │    themselves (MusicKit tokens are read via browser.evalAsync, the        │
 * │    actual request goes through browser.fetch so it runs in-page with      │
 * │    the right Origin/credentials — no more manual shell-quoting of JS      │
 * │    source or exec() at all, so `sliccy:exec` isn't needed by this file).  │
 * │                                                                             │
 * │  • const cli = require('sliccy:cli'); — every `console.error(msg) +       │
 * │    process.exit(1)` pair (usage errors, auth errors, API errors) is       │
 * │    replaced 1:1 with `cli.die(msg, { prefix: '' })`. `cli.die` defaults   │
 * │    to prepending "Error: " to the message; `{ prefix: '' }` suppresses    │
 * │    that so stderr text stays byte-for-byte identical to the original      │
 * │    bare `console.error(...)` output. The top-level `--help`/`-h`/         │
 * │    no-args path uses `cli.help(text)` instead of `console.log(text);      │
 * │    process.exit(0)` — same text, same exit code 0. The final `default:`   │
 * │    branch (unknown subcommand) still prints the usage dump via            │
 * │    printUsage() *before* the die(), matching the original ordering        │
 * │    (usage on stdout, then the error on stderr, then exit 1).              │
 * │                                                                             │
 * │  • Flag parsing uses the runtime-provided `process.argv.parseFlags()`     │
 * │    global; the former hand-rolled parseFlags() helper was removed.        │
 * │                                                                             │
 * │ No subcommands, flags, output formatting, or behavior were changed.       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */

const browser = require('sliccy:browser');
const fmt = require('sliccy:fmt');
const cli = require('sliccy:cli');

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  cli.help(usageText());
}

const subcommand = args[0];

// Flag parsing is provided by the runtime: process.argv.parseFlags() skips
// argv[0]/argv[1] and returns { positional, flags, subcommand, passthrough }.
// positional[0] is the subcommand, so the args for a subcommand are
// positional.slice(1).
const parsedArgv = process.argv.parseFlags();
const flags = parsedArgv.flags;
const positional = parsedArgv.positional.slice(1);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usageText() {
  return `apple-music — Apple Music CLI for SLICC

Usage:
  apple-music search <query> [--type songs|albums|artists|playlists] [--limit N]
  apple-music playlists
  apple-music playlist <id>
  apple-music create-playlist <name> [--description "..."]
  apple-music edit-playlist <id> [--name "..."] [--description "..."]
  apple-music delete-playlist <id>
  apple-music add-tracks <playlistId> <catalogSongId> [...]
  apple-music remove-track <playlistId> <librarySongId>
  apple-music reorder <playlistId> <libSongId1> [libSongId2] ...

ID conventions:
  Catalog song IDs  — numeric (e.g. 1731434189). From search results. Used to add tracks.
  Library song IDs  — i.xxx format (e.g. i.zpZxmA9tDARo7). From playlist tracks. Used to remove/reorder.
  Playlist IDs      — p.xxx format (e.g. p.V7VYJJMcvl92Y).`;
}

function printUsage() {
  console.log(usageText());
}

/**
 * Format milliseconds as M:SS.
 */
function fmtDuration(ms) {
  if (!ms) return '--:--';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Format a date string to YYYY-MM-DD.
 */
function fmtDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.slice(0, 10);
}

// ─── Apple Music Tab Management ──────────────────────────────────────────────

/**
 * Find an open Apple Music tab or open one.
 * Returns a browser TabHandle.
 */
async function getAppleMusicTab() {
  let tab = await browser.findTab({ domain: 'music.apple.com' });
  if (tab) return tab;

  // No Apple Music tab found — open one
  console.log('No Apple Music tab found. Opening one...');
  try {
    tab = await browser.ensureTab('https://music.apple.com');
  } catch (e) {
    cli.die('Failed to open Apple Music: ' + e.message, { prefix: '' });
  }

  // Wait a moment for page to load
  console.log('Waiting for Apple Music to load...');
  await new Promise((r) => setTimeout(r, 3000));

  return tab;
}

/**
 * Detect the user's storefront from the Apple Music page URL.
 * Falls back to 'us' if detection fails.
 */
async function detectStorefront(tab) {
  try {
    const href = await browser.eval(tab, () => window.location.href);
    if (href) {
      // URL like https://music.apple.com/de/browse or https://music.apple.com/us/...
      const urlMatch = href.match(/music\.apple\.com\/([a-z]{2})\b/);
      if (urlMatch) return urlMatch[1];
    }
  } catch (e) {
    // eval can reject (tab closed / navigation) — fall back to the default.
  }
  return 'us';
}

/**
 * Detect the locale from the storefront. Simple mapping.
 */
function storefrontToLocale(sf) {
  const map = {
    us: 'en-US', gb: 'en-GB', de: 'de-DE', fr: 'fr-FR', es: 'es-ES',
    it: 'it-IT', jp: 'ja-JP', kr: 'ko-KR', br: 'pt-BR', ca: 'en-CA',
    au: 'en-AU', mx: 'es-MX', nl: 'nl-NL', se: 'sv-SE', no: 'nb-NO',
    dk: 'da-DK', fi: 'fi-FI', at: 'de-AT', ch: 'de-CH', be: 'fr-BE',
    pt: 'pt-PT', pl: 'pl-PL', in: 'en-IN', sg: 'en-SG', nz: 'en-NZ',
  };
  return map[sf] || 'en-US';
}

/**
 * Execute a fetch call inside the Apple Music tab via the sliccy:browser bridge.
 * Returns the parsed JSON response.
 *
 * @param {object} tab - The browser TabHandle
 * @param {string} url - Full URL to fetch
 * @param {object} [options] - Fetch options (method, headers, body)
 * @returns {object} { status, ok, data }
 */
async function amFetch(tab, url, options = {}) {
  const method = options.method || 'GET';

  // Read MusicKit's tokens from the page context. Guarded because MusicKit may
  // be missing/not ready (fresh tab, sign-in/interstitial) — surface the clean
  // "Not authenticated" path instead of an unhandled realm error.
  let tokens = null;
  try {
    tokens = await browser.evalAsync(tab, async () => {
      const mk = window.MusicKit?.getInstance?.();
      if (!mk) return null;
      return {
        devToken: mk.developerToken,
        userToken: mk.musicUserToken,
      };
    });
  } catch (e) {
    tokens = null;
  }

  if (!tokens || !tokens.devToken || !tokens.userToken) {
    cli.die('Not authenticated. Please sign in to Apple Music in the browser tab and try again.', { prefix: '' });
  }

  let resp;
  try {
    resp = await browser.fetch(tab, url, {
      method,
      headers: {
        Authorization: 'Bearer ' + tokens.devToken,
        'media-user-token': tokens.userToken,
        'Content-Type': 'application/json',
        Origin: 'https://music.apple.com',
      },
      body: options.body,
    });
  } catch (e) {
    cli.die('Fetch error: ' + e.message, { prefix: '' });
  }

  const status = resp.status;
  const data = status === 204 ? null : resp.body;
  const parsed = { status, ok: resp.ok, data };

  if (parsed.status === 401 || parsed.status === 403) {
    cli.die(`Authentication error (HTTP ${parsed.status}). Your Apple Music session may have expired. Please refresh the Apple Music tab and sign in again.`, { prefix: '' });
  }
  if (!parsed.ok && parsed.status) {
    cli.die(`API error (HTTP ${parsed.status}): ${JSON.stringify(parsed.data).slice(0, 500)}`, { prefix: '' });
  }

  return parsed;
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function cmdSearch() {
  const query = positional.join(' ');
  if (!query) {
    cli.die('Usage: apple-music search <query> [--type songs|albums|artists|playlists] [--limit N]', { prefix: '' });
  }

  const type = flags.type || 'songs';
  const limit = flags.limit || '15';
  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  const params = new URLSearchParams({
    term: query,
    types: type,
    limit: String(limit),
    'format[resources]': 'map',
    platform: 'web',
    l: locale,
  });

  if (type === 'songs') {
    params.set('include[songs]', 'artists');
    params.set('relate[songs]', 'albums');
  }

  const url = `https://amp-api-edge.music.apple.com/v1/catalog/${storefront}/search?${params}`;
  const resp = await amFetch(tab, url);
  const data = resp.data;

  if (!data || !data.results) {
    console.log('No results found.');
    return;
  }

  // Determine which result type to display
  // API returns singular key (e.g., "song") when multiple types requested,
  // but plural key (e.g., "songs") when a single type is requested.
  const resultSet = data.results[type] || data.results[type.replace(/s$/, '')] || data.results[type + 's'];

  if (!resultSet || !resultSet.data || resultSet.data.length === 0) {
    console.log(`No ${type} found for "${query}".`);
    return;
  }

  // Get resources map
  const resources = data.resources || {};

  if (type === 'songs') {
    const songs = resources.songs || {};
    console.log(fmt.col('ID', 14) + fmt.col('Name', 36) + fmt.col('Artist', 24) + fmt.col('Album', 28) + 'Duration');
    console.log('-'.repeat(110));
    for (const item of resultSet.data) {
      const s = songs[item.id];
      if (!s) continue;
      const a = s.attributes || {};
      console.log(
        fmt.col(s.id, 14) +
        fmt.col(a.name, 36) +
        fmt.col(a.artistName, 24) +
        fmt.col(a.albumName, 28) +
        fmtDuration(a.durationInMillis)
      );
    }
  } else if (type === 'albums') {
    const albums = resources.albums || {};
    console.log(fmt.col('ID', 14) + fmt.col('Name', 40) + fmt.col('Artist', 28) + 'Released');
    console.log('-'.repeat(94));
    for (const item of resultSet.data) {
      const a = albums[item.id];
      if (!a) continue;
      const attr = a.attributes || {};
      console.log(
        fmt.col(a.id, 14) +
        fmt.col(attr.name, 40) +
        fmt.col(attr.artistName, 28) +
        fmtDate(attr.releaseDate)
      );
    }
  } else if (type === 'artists') {
    const artists = resources.artists || {};
    console.log(fmt.col('ID', 14) + fmt.col('Name', 40) + 'Genre');
    console.log('-'.repeat(74));
    for (const item of resultSet.data) {
      const a = artists[item.id];
      if (!a) continue;
      const attr = a.attributes || {};
      const genre = (attr.genreNames || []).join(', ');
      console.log(fmt.col(a.id, 14) + fmt.col(attr.name, 40) + genre);
    }
  } else if (type === 'playlists') {
    const playlists = resources.playlists || {};
    console.log(fmt.col('ID', 18) + fmt.col('Name', 44) + 'Curator');
    console.log('-'.repeat(82));
    for (const item of resultSet.data) {
      const p = playlists[item.id];
      if (!p) continue;
      const attr = p.attributes || {};
      console.log(fmt.col(p.id, 18) + fmt.col(attr.name, 44) + (attr.curatorName || ''));
    }
  }

  const total = resultSet.data.length;
  console.log(`\n${total} result${total !== 1 ? 's' : ''} shown.`);
}

async function cmdPlaylists() {
  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  let allPlaylists = [];
  let nextUrl = `https://amp-api.music.apple.com/v1/me/library/playlist-folders/p.playlistsroot/children?format[resources]=map&extend=hasCollaboration&extend[library-playlists]=tags&platform=web&l=${locale}`;

  while (nextUrl) {
    const resp = await amFetch(tab, nextUrl);
    const data = resp.data;
    if (!data) break;

    // Collect playlists from resources map
    const playlists = (data.resources && data.resources['library-playlists']) || {};
    // Use data array for ordering
    const dataItems = data.data || [];
    for (const item of dataItems) {
      const pl = playlists[item.id];
      if (pl) allPlaylists.push(pl);
    }

    if (data.next) {
      nextUrl = `https://amp-api.music.apple.com${data.next}`;
    } else {
      nextUrl = null;
    }
  }

  if (allPlaylists.length === 0) {
    console.log('No playlists found in your library.');
    return;
  }

  console.log(fmt.col('ID', 24) + fmt.col('Name', 40) + fmt.col('Modified', 12) + 'Public');
  console.log('-'.repeat(82));
  for (const pl of allPlaylists) {
    const a = pl.attributes || {};
    console.log(
      fmt.col(pl.id, 24) +
      fmt.col(a.name, 40) +
      fmt.col(fmtDate(a.lastModifiedDate || a.dateAdded), 12) +
      (a.isPublic ? 'yes' : 'no')
    );
  }
  console.log(`\n${allPlaylists.length} playlist${allPlaylists.length !== 1 ? 's' : ''}.`);
}

async function cmdPlaylist() {
  const playlistId = positional[0];
  if (!playlistId) {
    cli.die('Usage: apple-music playlist <playlistId>', { prefix: '' });
  }

  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  // Fetch playlist details
  const detailUrl = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?format[resources]=map&platform=web&l=${locale}`;
  const detailResp = await amFetch(tab, detailUrl);
  const detailData = detailResp.data;

  if (detailData && detailData.data && detailData.data.length > 0) {
    const plResources = (detailData.resources && detailData.resources['library-playlists']) || {};
    const pl = plResources[playlistId] || detailData.data[0];
    const a = pl.attributes || {};
    console.log(`Playlist: ${a.name || playlistId}`);
    if (a.description && a.description.standard) console.log(`Description: ${a.description.standard}`);
    console.log(`ID: ${playlistId}`);
    console.log(`Public: ${a.isPublic ? 'yes' : 'no'}`);
    console.log(`Modified: ${fmtDate(a.lastModifiedDate || a.dateAdded)}`);
    console.log('');
  }

  // Fetch tracks
  const tracksUrl = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?format[resources]=map&platform=web&l=${locale}`;
  const tracksResp = await amFetch(tab, tracksUrl);
  const tracksData = tracksResp.data;

  if (!tracksData || !tracksData.data || tracksData.data.length === 0) {
    console.log('No tracks in this playlist.');
    return;
  }

  const libSongs = (tracksData.resources && tracksData.resources['library-songs']) || {};
  const trackItems = tracksData.data || [];

  console.log(fmt.col('#', 4) + fmt.col('Library ID', 22) + fmt.col('Name', 36) + fmt.col('Artist', 24) + fmt.col('Catalog ID', 14) + 'Duration');
  console.log('-'.repeat(108));
  let idx = 1;
  for (const item of trackItems) {
    const s = libSongs[item.id] || {};
    const a = s.attributes || {};
    const catalogId = (a.playParams && a.playParams.catalogId) || '';
    console.log(
      fmt.col(String(idx), 4) +
      fmt.col(item.id, 22) +
      fmt.col(a.name, 36) +
      fmt.col(a.artistName, 24) +
      fmt.col(catalogId, 14) +
      fmtDuration(a.durationInMillis)
    );
    idx++;
  }
  console.log(`\n${trackItems.length} track${trackItems.length !== 1 ? 's' : ''}.`);
}

async function cmdCreatePlaylist() {
  const name = positional.join(' ');
  if (!name) {
    cli.die('Usage: apple-music create-playlist <name> [--description "..."]', { prefix: '' });
  }

  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  const body = {
    attributes: {
      name: name,
      isPublic: false,
    },
  };
  if (flags.description) {
    body.attributes.description = flags.description;
  }

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists?art[url]=f&l=${locale}`;
  const resp = await amFetch(tab, url, { method: 'POST', body });

  if (resp.data && resp.data.data && resp.data.data.length > 0) {
    const created = resp.data.data[0];
    const a = created.attributes || {};
    console.log(`Created playlist: ${a.name || name}`);
    console.log(`ID: ${created.id}`);
  } else if (resp.data) {
    // Some responses might use resources map
    const playlists = (resp.data.resources && resp.data.resources['library-playlists']) || {};
    const ids = Object.keys(playlists);
    if (ids.length > 0) {
      const pl = playlists[ids[0]];
      console.log(`Created playlist: ${(pl.attributes || {}).name || name}`);
      console.log(`ID: ${pl.id}`);
    } else {
      console.log('Playlist created successfully.');
      console.log(JSON.stringify(resp.data, null, 2));
    }
  } else {
    console.log('Playlist created successfully.');
  }
}

async function cmdEditPlaylist() {
  const playlistId = positional[0];
  if (!playlistId) {
    cli.die('Usage: apple-music edit-playlist <id> [--name "..."] [--description "..."]', { prefix: '' });
  }

  if (!flags.name && !flags.description) {
    cli.die('Provide at least --name or --description to update.', { prefix: '' });
  }

  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  const body = { attributes: {} };
  if (flags.name) body.attributes.name = flags.name;
  if (flags.description) body.attributes.description = flags.description;

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?art[url]=f&format[resources]=map&platform=web&l=${locale}`;
  await amFetch(tab, url, { method: 'PATCH', body });
  console.log(`Playlist ${playlistId} updated.`);
}

async function cmdDeletePlaylist() {
  const playlistId = positional[0];
  if (!playlistId) {
    cli.die('Usage: apple-music delete-playlist <playlistId>', { prefix: '' });
  }

  const tab = await getAppleMusicTab();

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?art[url]=f`;
  await amFetch(tab, url, { method: 'DELETE' });
  console.log(`Playlist ${playlistId} deleted.`);
}

async function cmdAddTracks() {
  if (positional.length < 2) {
    cli.die('Usage: apple-music add-tracks <playlistId> <catalogSongId> [catalogSongId2] ...', { prefix: '' });
  }

  const playlistId = positional[0];
  const songIds = positional.slice(1);

  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  const body = {
    data: songIds.map(id => ({ id, type: 'songs' })),
  };

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?art[url]=f&l=${locale}&representation=resources`;
  await amFetch(tab, url, { method: 'POST', body });
  console.log(`Added ${songIds.length} track${songIds.length !== 1 ? 's' : ''} to playlist ${playlistId}.`);
  for (const id of songIds) {
    console.log(`  + ${id}`);
  }
}

async function cmdRemoveTrack() {
  if (positional.length < 2) {
    cli.die('Usage: apple-music remove-track <playlistId> <librarySongId>', { prefix: '' });
  }

  const playlistId = positional[0];
  const librarySongId = positional[1];

  const tab = await getAppleMusicTab();

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?ids[library-songs]=${encodeURIComponent(librarySongId)}&mode=all&art[url]=f`;
  await amFetch(tab, url, { method: 'DELETE' });
  console.log(`Removed ${librarySongId} from playlist ${playlistId}.`);
}

async function cmdReorder() {
  if (positional.length < 2) {
    cli.die(
      'Usage: apple-music reorder <playlistId> <libSongId1> [libSongId2] ...\n' +
      'List ALL library song IDs in the desired order. This replaces the full track list.',
      { prefix: '' }
    );
  }

  const playlistId = positional[0];
  const trackIds = positional.slice(1);

  const tab = await getAppleMusicTab();
  const storefront = await detectStorefront(tab);
  const locale = storefrontToLocale(storefront);

  const body = {
    data: trackIds.map(id => ({ id, type: 'library-songs' })),
  };

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?art[url]=f&format[resources]=map&platform=web&l=${locale}`;
  await amFetch(tab, url, { method: 'PUT', body });
  console.log(`Reordered ${trackIds.length} track${trackIds.length !== 1 ? 's' : ''} in playlist ${playlistId}.`);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

async function main() {
  switch (subcommand) {
    case 'search':
      await cmdSearch();
      break;
    case 'playlists':
      await cmdPlaylists();
      break;
    case 'playlist':
      await cmdPlaylist();
      break;
    case 'create-playlist':
      await cmdCreatePlaylist();
      break;
    case 'edit-playlist':
      await cmdEditPlaylist();
      break;
    case 'delete-playlist':
      await cmdDeletePlaylist();
      break;
    case 'add-tracks':
      await cmdAddTracks();
      break;
    case 'remove-track':
      await cmdRemoveTrack();
      break;
    case 'reorder':
      await cmdReorder();
      break;
    default:
      printUsage();
      cli.die(`Unknown command: ${subcommand}`, { prefix: '' });
  }
}

await main();
