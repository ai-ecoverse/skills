#!/usr/bin/env jsh
// swarm.jsh  Foursquare/Swarm check-in history CLI

const args = process.argv.slice(2);
const command = args[0];

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function parseFlag(name) {
  const prefix = `--${name}=`;
  const arg = args.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function positionalAfter(index) {
  return args.slice(index).filter(a => !a.startsWith('--'));
}

async function findFoursquareTab() {
  const { stdout } = await exec('playwright-cli tab-list');
  const lines = stdout.split('\n');
  for (const line of lines) {
    const match = line.match(/\[([A-F0-9]+)\]\s+https?:\/\/[^\s]*app\.foursquare\.com/);
    if (match) return match[1];
  }
  return null;
}

async function apiCall(tabId, endpoint) {
  const url = `https://api.foursquare.com/v2${endpoint}${endpoint.includes('?') ? '&' : '?'}v=20231001`;
  const expr = `fetch('${url}',{credentials:'include'}).then(r=>r.json()).then(d=>JSON.stringify(d))`;
  const { stdout } = await exec(`playwright-cli eval --tab=${tabId} "${expr.replace(/"/g, '\\"')}"`);
  // stdout may have quotes wrapping the JSON string  parse it
  let cleaned = stdout.trim();
  // playwright-cli eval may return the result as a quoted JSON string
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = JSON.parse(cleaned);
  }
  return JSON.parse(cleaned);
}

function formatDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function cmdCheckins(tabId) {
  const limit = parseFlag('limit') || '20';
  const offset = parseFlag('offset') || '0';
  const category = parseFlag('category');
  let endpoint = `/users/self/checkins?limit=${limit}&offset=${offset}`;
  if (category) endpoint += `&categoryId=${category}`;

  const data = await apiCall(tabId, endpoint);
  const checkins = data.response.checkins.items;
  const total = data.response.checkins.count;

  console.log(`${BOLD}Check-ins${RESET} ${GRAY}(${checkins.length} of ${total})${RESET}\n`);

  for (const ci of checkins) {
    const venue = ci.venue || {};
    const name = venue.name || 'Unknown venue';
    const city = (venue.location && venue.location.city) || '';
    const cat = (venue.categories && venue.categories[0] && venue.categories[0].name) || '';
    const date = formatDate(ci.createdAt);
    console.log(`  ${CYAN}${name}${RESET}${city ? ` ${GRAY} ${city}${RESET}` : ''}`);
    console.log(`    ${YELLOW}${cat}${RESET}  ${GRAY}${date}${RESET}`);
  }
}

async function cmdHistory(tabId) {
  const category = parseFlag('category');
  let endpoint = `/users/self/venuehistory?`;
  if (category) endpoint += `categoryId=${category}&`;
  endpoint = endpoint.replace(/[&?]$/, '') || endpoint;

  const data = await apiCall(tabId, endpoint.endsWith('?') ? endpoint.slice(0, -1) : endpoint);
  const venues = data.response.venues.items;

  // Sort by beenHere descending
  venues.sort((a, b) => b.beenHere - a.beenHere);

  console.log(`${BOLD}Venue History${RESET} ${GRAY}(${venues.length} venues)${RESET}\n`);

  for (const v of venues) {
    const venue = v.venue || v;
    const name = venue.name || 'Unknown';
    const city = (venue.location && venue.location.city) || '';
    const count = v.beenHere || 0;
    console.log(`  ${CYAN}${name}${RESET}${city ? ` ${GRAY} ${city}${RESET}` : ''}  ${YELLOW}×${count}${RESET}`);
  }
}

async function cmdSearch(tabId) {
  const near = parseFlag('near');
  if (!near) {
    console.error(`${YELLOW}Error:${RESET} --near=<lat,lng> is required for search`);
    process.exit(1);
  }
  const queryParts = positionalAfter(1);
  const query = queryParts.join(' ');
  if (!query) {
    console.error(`${YELLOW}Error:${RESET} search query is required`);
    process.exit(1);
  }

  const endpoint = `/venues/search?ll=${near}&query=${encodeURIComponent(query)}&limit=10`;
  const data = await apiCall(tabId, endpoint);
  const venues = data.response.venues || [];

  console.log(`${BOLD}Search: "${query}"${RESET} ${GRAY}near ${near}${RESET}\n`);

  for (const v of venues) {
    const city = (v.location && v.location.city) || '';
    const cat = (v.categories && v.categories[0] && v.categories[0].name) || '';
    const dist = v.location && v.location.distance ? `${v.location.distance}m` : '';
    console.log(`  ${CYAN}${v.name}${RESET}${city ? ` ${GRAY} ${city}${RESET}` : ''} ${dist ? GRAY + dist + RESET : ''}`);
    console.log(`    ${YELLOW}${cat}${RESET}  ${GRAY}id: ${v.id}${RESET}`);
  }
}

async function cmdVenue(tabId) {
  const venueId = args[1];
  if (!venueId || venueId.startsWith('--')) {
    console.error(`${YELLOW}Error:${RESET} venue ID is required`);
    process.exit(1);
  }

  const data = await apiCall(tabId, `/venues/${venueId}?`);
  const v = data.response.venue;

  console.log(`\n${BOLD}${CYAN}${v.name}${RESET}`);
  if (v.categories && v.categories[0]) {
    console.log(`  ${YELLOW}${v.categories[0].name}${RESET}`);
  }
  if (v.location) {
    const loc = v.location;
    const addr = [loc.address, loc.city, loc.state, loc.country].filter(Boolean).join(', ');
    console.log(`  ${GRAY}${addr}${RESET}`);
  }
  if (v.rating) {
    console.log(`  Rating: ${CYAN}${v.rating}${RESET}/10`);
  }
  if (v.beenHere && v.beenHere.count) {
    console.log(`  ${YELLOW}You've been here ${v.beenHere.count} time(s)${RESET}`);
  }
  if (v.url) {
    console.log(`  ${GRAY}${v.url}${RESET}`);
  }
  if (v.hours && v.hours.status) {
    console.log(`  ${GRAY}${v.hours.status}${RESET}`);
  }
  console.log();
}

async function cmdStats(tabId) {
  // Get total checkins count
  const checkinsData = await apiCall(tabId, `/users/self/checkins?limit=1&offset=0`);
  const totalCheckins = checkinsData.response.checkins.count;

  // Get venue history for count and top venues
  const historyData = await apiCall(tabId, `/users/self/venuehistory?`);
  const venues = historyData.response.venues.items;
  const totalVenues = venues.length;

  // Sort by visits
  venues.sort((a, b) => b.beenHere - a.beenHere);
  const top5 = venues.slice(0, 5);

  console.log(`\n${BOLD}Swarm Stats${RESET}\n`);
  console.log(`  Total check-ins:  ${CYAN}${totalCheckins}${RESET}`);
  console.log(`  Unique venues:    ${CYAN}${totalVenues}${RESET}`);
  console.log(`\n  ${BOLD}Top 5 Venues${RESET}`);

  for (let i = 0; i < top5.length; i++) {
    const v = top5[i];
    const venue = v.venue || v;
    const name = venue.name || 'Unknown';
    const city = (venue.location && venue.location.city) || '';
    console.log(`    ${YELLOW}${i + 1}.${RESET} ${CYAN}${name}${RESET}${city ? ` ${GRAY} ${city}${RESET}` : ''} ${YELLOW}×${v.beenHere}${RESET}`);
  }
  console.log();
}

// Main
(async () => {
  if (!command || command === '--help' || command === '-h') {
    console.log(`${BOLD}swarm${RESET}  Foursquare/Swarm check-in history\n`);
    console.log(`Usage:`);
    console.log(`  swarm checkins [--limit=N] [--offset=N] [--category=<id>]`);
    console.log(`  swarm history [--category=<id>]`);
    console.log(`  swarm search <query> --near=<lat,lng>`);
    console.log(`  swarm venue <venue-id>`);
    console.log(`  swarm stats`);
    process.exit(0);
  }

  const tabId = await findFoursquareTab();
  if (!tabId) {
    console.error(`${YELLOW}Error:${RESET} No Foursquare tab found.`);
    console.error(`Please open ${CYAN}https://app.foursquare.com${RESET} in your browser and try again.`);
    process.exit(1);
  }

  switch (command) {
    case 'checkins':
      await cmdCheckins(tabId);
      break;
    case 'history':
      await cmdHistory(tabId);
      break;
    case 'search':
      await cmdSearch(tabId);
      break;
    case 'venue':
      await cmdVenue(tabId);
      break;
    case 'stats':
      await cmdStats(tabId);
      break;
    default:
      console.error(`${YELLOW}Unknown command:${RESET} ${command}`);
      process.exit(1);
  }
})();
