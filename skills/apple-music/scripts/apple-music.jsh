/**
 * apple-music.jsh — Apple Music CLI for SLICC
 *
 * Manages Apple Music library and catalog operations via the Apple Music web API.
 * Uses page-context fetch through playwright-cli eval to handle authentication.
 *
 * @requires minimist
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
 */

// ─── Argument Parsing ────────────────────────────────────────────────────────

const minimist = require('minimist');
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printUsage();
  process.exit(0);
}

const subcommand = args[0];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse --flag and --flag=value from args array.
 * Returns { flags: {key: value}, positional: [remaining args] }
 */
function parseFlags(argsSlice) {
  const { _, ...flags } = minimist(argsSlice);
  return { flags, positional: _ };
}

function printUsage() {
  console.log(`apple-music — Apple Music CLI for SLICC

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
  Playlist IDs      — p.xxx format (e.g. p.V7VYJJMcvl92Y).`);
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
 * Pad/truncate string to fixed width.
 */
function col(str, width) {
  if (str == null) str = '';
  str = String(str);
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
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
 * Returns the targetId.
 */
async function getAppleMusicTab() {
  // List tabs and look for music.apple.com
  const listResult = await exec('playwright-cli tab-list');
  if (listResult.exitCode !== 0) {
    console.error('Error listing tabs: ' + listResult.stderr);
    process.exit(1);
  }

  const lines = listResult.stdout.trim().split('\n');
  for (const line of lines) {
    // Match lines like: [TARGET_ID] https://music.apple.com/... "Title" (maybe active)
    if (line.includes('music.apple.com')) {
      const match = line.match(/^\[([^\]]+)\]/);
      if (match) return match[1];
    }
  }

  // No Apple Music tab found — open one
  console.log('No Apple Music tab found. Opening one...');
  const openResult = await exec('playwright-cli tab-new https://music.apple.com');
  if (openResult.exitCode !== 0) {
    console.error('Failed to open Apple Music: ' + openResult.stderr);
    process.exit(1);
  }

  // Extract targetId from output
  const openMatch = openResult.stdout.match(/\[([^\]]+)\]/);
  if (!openMatch) {
    console.error('Could not determine tab ID from: ' + openResult.stdout);
    process.exit(1);
  }
  const tabId = openMatch[1];

  // Wait a moment for page to load
  console.log('Waiting for Apple Music to load...');
  await new Promise(r => setTimeout(r, 3000));

  return tabId;
}

/**
 * Detect the user's storefront from the Apple Music page URL.
 * Falls back to 'us' if detection fails.
 */
async function detectStorefront(tabId) {
  const result = await exec(`playwright-cli eval --tab=${tabId} "window.location.href"`);
  if (result.exitCode === 0) {
    // URL like https://music.apple.com/de/browse or https://music.apple.com/us/...
    const urlMatch = result.stdout.match(/music\.apple\.com\/([a-z]{2})\b/);
    if (urlMatch) return urlMatch[1];
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
 * Execute a fetch call inside the Apple Music tab via playwright-cli eval.
 * Returns the parsed JSON response.
 *
 * @param {string} tabId - The playwright tab targetId
 * @param {string} url - Full URL to fetch
 * @param {object} [options] - Fetch options (method, headers, body)
 * @returns {object} { status, ok, data }
 */
async function amFetch(tabId, url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : null;

  // Build the JS to run inside the page context.
  // We use MusicKit's tokens and the native fetch API.
  let jsCode = `
    (async () => {
      try {
        const mk = window.MusicKit.getInstance();
        const devToken = mk.developerToken;
        const userToken = mk.musicUserToken;
        if (!devToken || !userToken) {
          return JSON.stringify({ error: 'NOT_AUTHENTICATED', message: 'Apple Music tokens not available. Please sign in.' });
        }
        const resp = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          headers: {
            'Authorization': 'Bearer ' + devToken,
            'media-user-token': userToken,
            'Content-Type': 'application/json',
            'Origin': 'https://music.apple.com'
          }${body ? `,\n          body: ${JSON.stringify(body)}` : ''}
        });
        const status = resp.status;
        if (status === 204) {
          return JSON.stringify({ status: 204, ok: true, data: null });
        }
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch(e) { data = text; }
        return JSON.stringify({ status, ok: resp.ok, data });
      } catch (e) {
        return JSON.stringify({ error: 'FETCH_ERROR', message: e.message });
      }
    })()
  `.trim();

  // Escape for shell: we pass the JS as a single-quoted argument to eval.
  // Replace single quotes in the JS with the shell escape pattern '\''
  const escapedJs = jsCode.replace(/'/g, "'\\''");

  const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
  if (result.exitCode !== 0) {
    console.error('eval failed: ' + (result.stderr || result.stdout));
    process.exit(1);
  }

  // The eval output has the JSON string (possibly with extra quotes from playwright)
  let raw = result.stdout.trim();
  // playwright-cli eval wraps the return in quotes and escapes — parse it
  let parsed;
  try {
    // First try direct parse (if playwright returned raw JSON)
    parsed = JSON.parse(raw);
  } catch (e) {
    // Might be double-encoded string
    try {
      parsed = JSON.parse(JSON.parse(raw));
    } catch (e2) {
      console.error('Failed to parse API response: ' + raw.slice(0, 500));
      process.exit(1);
    }
  }

  if (parsed.error === 'NOT_AUTHENTICATED') {
    console.error('Not authenticated. Please sign in to Apple Music in the browser tab and try again.');
    process.exit(1);
  }
  if (parsed.error === 'FETCH_ERROR') {
    console.error('Fetch error: ' + parsed.message);
    process.exit(1);
  }
  if (parsed.status === 401 || parsed.status === 403) {
    console.error(`Authentication error (HTTP ${parsed.status}). Your Apple Music session may have expired. Please refresh the Apple Music tab and sign in again.`);
    process.exit(1);
  }
  if (!parsed.ok && parsed.status) {
    console.error(`API error (HTTP ${parsed.status}): ${JSON.stringify(parsed.data).slice(0, 500)}`);
    process.exit(1);
  }

  return parsed;
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function cmdSearch() {
  const { flags, positional } = parseFlags(args.slice(1));
  const query = positional.join(' ');
  if (!query) {
    console.error('Usage: apple-music search <query> [--type songs|albums|artists|playlists] [--limit N]');
    process.exit(1);
  }

  const type = flags.type || 'songs';
  const limit = flags.limit || '15';
  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
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
  const resp = await amFetch(tabId, url);
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
    console.log(col('ID', 14) + col('Name', 36) + col('Artist', 24) + col('Album', 28) + 'Duration');
    console.log('-'.repeat(110));
    for (const item of resultSet.data) {
      const s = songs[item.id];
      if (!s) continue;
      const a = s.attributes || {};
      console.log(
        col(s.id, 14) +
        col(a.name, 36) +
        col(a.artistName, 24) +
        col(a.albumName, 28) +
        fmtDuration(a.durationInMillis)
      );
    }
  } else if (type === 'albums') {
    const albums = resources.albums || {};
    console.log(col('ID', 14) + col('Name', 40) + col('Artist', 28) + 'Released');
    console.log('-'.repeat(94));
    for (const item of resultSet.data) {
      const a = albums[item.id];
      if (!a) continue;
      const attr = a.attributes || {};
      console.log(
        col(a.id, 14) +
        col(attr.name, 40) +
        col(attr.artistName, 28) +
        fmtDate(attr.releaseDate)
      );
    }
  } else if (type === 'artists') {
    const artists = resources.artists || {};
    console.log(col('ID', 14) + col('Name', 40) + 'Genre');
    console.log('-'.repeat(74));
    for (const item of resultSet.data) {
      const a = artists[item.id];
      if (!a) continue;
      const attr = a.attributes || {};
      const genre = (attr.genreNames || []).join(', ');
      console.log(col(a.id, 14) + col(attr.name, 40) + genre);
    }
  } else if (type === 'playlists') {
    const playlists = resources.playlists || {};
    console.log(col('ID', 18) + col('Name', 44) + 'Curator');
    console.log('-'.repeat(82));
    for (const item of resultSet.data) {
      const p = playlists[item.id];
      if (!p) continue;
      const attr = p.attributes || {};
      console.log(col(p.id, 18) + col(attr.name, 44) + (attr.curatorName || ''));
    }
  }

  const total = resultSet.data.length;
  console.log(`\n${total} result${total !== 1 ? 's' : ''} shown.`);
}

async function cmdPlaylists() {
  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
  const locale = storefrontToLocale(storefront);

  let allPlaylists = [];
  let nextUrl = `https://amp-api.music.apple.com/v1/me/library/playlist-folders/p.playlistsroot/children?format[resources]=map&extend=hasCollaboration&extend[library-playlists]=tags&platform=web&l=${locale}`;

  while (nextUrl) {
    const resp = await amFetch(tabId, nextUrl);
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

  console.log(col('ID', 24) + col('Name', 40) + col('Modified', 12) + 'Public');
  console.log('-'.repeat(82));
  for (const pl of allPlaylists) {
    const a = pl.attributes || {};
    console.log(
      col(pl.id, 24) +
      col(a.name, 40) +
      col(fmtDate(a.lastModifiedDate || a.dateAdded), 12) +
      (a.isPublic ? 'yes' : 'no')
    );
  }
  console.log(`\n${allPlaylists.length} playlist${allPlaylists.length !== 1 ? 's' : ''}.`);
}

async function cmdPlaylist() {
  const { positional } = parseFlags(args.slice(1));
  const playlistId = positional[0];
  if (!playlistId) {
    console.error('Usage: apple-music playlist <playlistId>');
    process.exit(1);
  }

  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
  const locale = storefrontToLocale(storefront);

  // Fetch playlist details
  const detailUrl = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?format[resources]=map&platform=web&l=${locale}`;
  const detailResp = await amFetch(tabId, detailUrl);
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
  const tracksResp = await amFetch(tabId, tracksUrl);
  const tracksData = tracksResp.data;

  if (!tracksData || !tracksData.data || tracksData.data.length === 0) {
    console.log('No tracks in this playlist.');
    return;
  }

  const libSongs = (tracksData.resources && tracksData.resources['library-songs']) || {};
  const trackItems = tracksData.data || [];

  console.log(col('#', 4) + col('Library ID', 22) + col('Name', 36) + col('Artist', 24) + col('Catalog ID', 14) + 'Duration');
  console.log('-'.repeat(108));
  let idx = 1;
  for (const item of trackItems) {
    const s = libSongs[item.id] || {};
    const a = s.attributes || {};
    const catalogId = (a.playParams && a.playParams.catalogId) || '';
    console.log(
      col(String(idx), 4) +
      col(item.id, 22) +
      col(a.name, 36) +
      col(a.artistName, 24) +
      col(catalogId, 14) +
      fmtDuration(a.durationInMillis)
    );
    idx++;
  }
  console.log(`\n${trackItems.length} track${trackItems.length !== 1 ? 's' : ''}.`);
}

async function cmdCreatePlaylist() {
  const { flags, positional } = parseFlags(args.slice(1));
  const name = positional.join(' ');
  if (!name) {
    console.error('Usage: apple-music create-playlist <name> [--description "..."]');
    process.exit(1);
  }

  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
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
  const resp = await amFetch(tabId, url, { method: 'POST', body });

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
  const { flags, positional } = parseFlags(args.slice(1));
  const playlistId = positional[0];
  if (!playlistId) {
    console.error('Usage: apple-music edit-playlist <id> [--name "..."] [--description "..."]');
    process.exit(1);
  }

  if (!flags.name && !flags.description) {
    console.error('Provide at least --name or --description to update.');
    process.exit(1);
  }

  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
  const locale = storefrontToLocale(storefront);

  const body = { attributes: {} };
  if (flags.name) body.attributes.name = flags.name;
  if (flags.description) body.attributes.description = flags.description;

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?art[url]=f&format[resources]=map&platform=web&l=${locale}`;
  await amFetch(tabId, url, { method: 'PATCH', body });
  console.log(`Playlist ${playlistId} updated.`);
}

async function cmdDeletePlaylist() {
  const { positional } = parseFlags(args.slice(1));
  const playlistId = positional[0];
  if (!playlistId) {
    console.error('Usage: apple-music delete-playlist <playlistId>');
    process.exit(1);
  }

  const tabId = await getAppleMusicTab();

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}?art[url]=f`;
  await amFetch(tabId, url, { method: 'DELETE' });
  console.log(`Playlist ${playlistId} deleted.`);
}

async function cmdAddTracks() {
  const { positional } = parseFlags(args.slice(1));
  if (positional.length < 2) {
    console.error('Usage: apple-music add-tracks <playlistId> <catalogSongId> [catalogSongId2] ...');
    process.exit(1);
  }

  const playlistId = positional[0];
  const songIds = positional.slice(1);

  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
  const locale = storefrontToLocale(storefront);

  const body = {
    data: songIds.map(id => ({ id, type: 'songs' })),
  };

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?art[url]=f&l=${locale}&representation=resources`;
  await amFetch(tabId, url, { method: 'POST', body });
  console.log(`Added ${songIds.length} track${songIds.length !== 1 ? 's' : ''} to playlist ${playlistId}.`);
  for (const id of songIds) {
    console.log(`  + ${id}`);
  }
}

async function cmdRemoveTrack() {
  const { positional } = parseFlags(args.slice(1));
  if (positional.length < 2) {
    console.error('Usage: apple-music remove-track <playlistId> <librarySongId>');
    process.exit(1);
  }

  const playlistId = positional[0];
  const librarySongId = positional[1];

  const tabId = await getAppleMusicTab();

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?ids[library-songs]=${encodeURIComponent(librarySongId)}&mode=all&art[url]=f`;
  await amFetch(tabId, url, { method: 'DELETE' });
  console.log(`Removed ${librarySongId} from playlist ${playlistId}.`);
}

async function cmdReorder() {
  const { positional } = parseFlags(args.slice(1));
  if (positional.length < 2) {
    console.error('Usage: apple-music reorder <playlistId> <libSongId1> [libSongId2] ...');
    console.error('List ALL library song IDs in the desired order. This replaces the full track list.');
    process.exit(1);
  }

  const playlistId = positional[0];
  const trackIds = positional.slice(1);

  const tabId = await getAppleMusicTab();
  const storefront = await detectStorefront(tabId);
  const locale = storefrontToLocale(storefront);

  const body = {
    data: trackIds.map(id => ({ id, type: 'library-songs' })),
  };

  const url = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?art[url]=f&format[resources]=map&platform=web&l=${locale}`;
  await amFetch(tabId, url, { method: 'PUT', body });
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
      console.error(`Unknown command: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

await main();
