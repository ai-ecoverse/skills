// swarm.jsh — Foursquare/Swarm check-in history CLI
// Ported to jsh runtime extensions (PR #786)
//
// Migrated:
//  • Colors: raw ANSI constants → c global
//  • Flag parsing: custom parseFlag() → process.argv.parseFlags()
//  • Tab discovery: exec('playwright-cli tab-list') + regex → browser.findTab()
//  • API calls: exec('playwright-cli eval') + double-JSON-unwrap → browser.fetch()
//  • Date formatting: custom formatDate() → fmt.date(ts*1000, 'locale')
//  • Error handling: console.error + process.exit → cli.die / cli.help

// ─── Runtime bridges (sliccy: virtual modules; bare globals hard-cut in slicc#786) ──
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const c = require('sliccy:color');
const fmt = require('sliccy:fmt');

const { positional, flags } = process.argv.parseFlags();
const command = positional[0];

// ─── Tab + API ───────────────────────────────────────────────────────────────

async function getTab() {
  const tab = await browser.findTab({ domain: 'app.foursquare.com' });
  if (!tab) {
    cli.die(`No Foursquare tab found.\nPlease open ${c.cyan('https://app.foursquare.com')} in your browser and try again.`, { prefix: 'swarm' });
  }
  return tab;
}

async function apiCall(tab, endpoint) {
  const url = `https://api.foursquare.com/v2${endpoint}${endpoint.includes('?') ? '&' : '?'}v=20231001`;
  const resp = await browser.fetch(tab, url, { credentials: 'include' });
  if (!resp.ok) {
    cli.die(`Foursquare API ${resp.status}: ${resp.body?.meta?.errorDetail || resp.statusText || 'request failed'}`, { prefix: 'swarm' });
  }
  const data = resp.body;
  if (data && data.meta && data.meta.code !== 200) {
    cli.die(`Foursquare API ${data.meta.code}: ${data.meta.errorType || ''} ${data.meta.errorDetail || ''}`.trim(), { prefix: 'swarm' });
  }
  return data;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdCheckins(tab) {
  const limit = flags.limit || '20';
  const offset = flags.offset || '0';
  const category = flags.category;
  let endpoint = `/users/self/checkins?limit=${limit}&offset=${offset}`;
  if (category) endpoint += `&categoryId=${category}`;

  const data = await apiCall(tab, endpoint);
  const checkins = data.response.checkins.items;
  const total = data.response.checkins.count;

  console.log(`${c.bold('Check-ins')} ${c.gray(`(${checkins.length} of ${total})`)}\n`);

  for (const ci of checkins) {
    const venue = ci.venue || {};
    const name = venue.name || 'Unknown venue';
    const city = (venue.location && venue.location.city) || '';
    const cat = (venue.categories && venue.categories[0] && venue.categories[0].name) || '';
    const date = fmt.date(ci.createdAt * 1000, 'locale');
    console.log(`  ${c.cyan(name)}${city ? ` ${c.gray('— ' + city)}` : ''}`);
    console.log(`    ${c.yellow(cat)}  ${c.gray(date)}`);
  }
}

async function cmdHistory(tab) {
  const category = flags.category;
  const endpoint = category
    ? `/users/self/venuehistory?categoryId=${category}`
    : '/users/self/venuehistory';

  const data = await apiCall(tab, endpoint);
  const venues = data.response.venues.items;

  venues.sort((a, b) => b.beenHere - a.beenHere);

  console.log(`${c.bold('Venue History')} ${c.gray(`(${venues.length} venues)`)}\n`);

  for (const v of venues) {
    const venue = v.venue || v;
    const name = venue.name || 'Unknown';
    const city = (venue.location && venue.location.city) || '';
    const count = v.beenHere || 0;
    console.log(`  ${c.cyan(name)}${city ? ` ${c.gray('— ' + city)}` : ''}  ${c.yellow('×' + count)}`);
  }
}

async function cmdSearch(tab) {
  const near = flags.near;
  if (!near) cli.die('--near=<lat,lng> is required for search', { prefix: 'swarm' });
  const query = positional.slice(1).join(' ');
  if (!query) cli.die('search query is required', { prefix: 'swarm' });

  const endpoint = `/venues/search?ll=${near}&query=${encodeURIComponent(query)}&limit=10`;
  const data = await apiCall(tab, endpoint);
  const venues = data.response.venues || [];

  console.log(`${c.bold(`Search: "${query}"`)} ${c.gray('near ' + near)}\n`);

  for (const v of venues) {
    const city = (v.location && v.location.city) || '';
    const cat = (v.categories && v.categories[0] && v.categories[0].name) || '';
    const dist = v.location && v.location.distance ? `${v.location.distance}m` : '';
    console.log(`  ${c.cyan(v.name)}${city ? ` ${c.gray('— ' + city)}` : ''} ${dist ? c.gray(dist) : ''}`);
    console.log(`    ${c.yellow(cat)}  ${c.gray('id: ' + v.id)}`);
  }
}

async function cmdVenue(tab) {
  const venueId = positional[1];
  if (!venueId) cli.die('venue ID is required', { prefix: 'swarm' });

  const data = await apiCall(tab, `/venues/${encodeURIComponent(venueId)}`);
  const v = data.response.venue;

  console.log(`\n${c.bold(c.cyan(v.name))}`);
  if (v.categories && v.categories[0]) {
    console.log(`  ${c.yellow(v.categories[0].name)}`);
  }
  if (v.location) {
    const loc = v.location;
    const addr = [loc.address, loc.city, loc.state, loc.country].filter(Boolean).join(', ');
    console.log(`  ${c.gray(addr)}`);
  }
  if (v.rating) {
    console.log(`  Rating: ${c.cyan(String(v.rating))}/10`);
  }
  if (v.beenHere && v.beenHere.count) {
    console.log(`  ${c.yellow(`You've been here ${v.beenHere.count} time(s)`)}`);
  }
  if (v.url) {
    console.log(`  ${c.gray(v.url)}`);
  }
  if (v.hours && v.hours.status) {
    console.log(`  ${c.gray(v.hours.status)}`);
  }
  console.log();
}

async function cmdStats(tab) {
  const checkinsData = await apiCall(tab, `/users/self/checkins?limit=1&offset=0`);
  const totalCheckins = checkinsData.response.checkins.count;

  const historyData = await apiCall(tab, '/users/self/venuehistory');
  const venues = historyData.response.venues.items;
  const totalVenues = venues.length;

  venues.sort((a, b) => b.beenHere - a.beenHere);
  const top5 = venues.slice(0, 5);

  console.log(`\n${c.bold('Swarm Stats')}\n`);
  console.log(`  Total check-ins:  ${c.cyan(String(totalCheckins))}`);
  console.log(`  Unique venues:    ${c.cyan(String(totalVenues))}`);
  console.log(`\n  ${c.bold('Top 5 Venues')}`);

  for (let i = 0; i < top5.length; i++) {
    const v = top5[i];
    const venue = v.venue || v;
    const name = venue.name || 'Unknown';
    const city = (venue.location && venue.location.city) || '';
    console.log(`    ${c.yellow((i + 1) + '.')} ${c.cyan(name)}${city ? ` ${c.gray('— ' + city)}` : ''} ${c.yellow('×' + v.beenHere)}`);
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (!command || command === '--help' || command === '-h') {
  cli.help(`${c.bold('swarm')} — Foursquare/Swarm check-in history

Usage:
  swarm checkins [--limit=N] [--offset=N] [--category=<id>]
  swarm history [--category=<id>]
  swarm search <query> --near=<lat,lng>
  swarm venue <venue-id>
  swarm stats`);
}

const tab = await getTab();

switch (command) {
  case 'checkins': await cmdCheckins(tab); break;
  case 'history':  await cmdHistory(tab); break;
  case 'search':   await cmdSearch(tab); break;
  case 'venue':    await cmdVenue(tab); break;
  case 'stats':    await cmdStats(tab); break;
  default:
    cli.die(`unknown command: ${command}. Run swarm --help for usage.`, { prefix: 'swarm' });
}
