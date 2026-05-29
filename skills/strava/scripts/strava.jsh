// strava.jsh — Strava browser-session client

const HELP = `
strava — Strava activity client (uses browser session)

USAGE
  strava me                    Current athlete profile
  strava feed [--limit N]      Activity feed (default: 10)
  strava feed --mine           Your own activities only
  strava prs                   Personal records
  strava activity <id>         Single activity details
  strava notifications         Notification count

FLAGS
  --limit N    Number of feed entries (default 10)
  --mine       Own activities only (feed_type=my_activity)
  --json       Output raw JSON

REQUIRES
  strava.com open and logged in in your browser
`.trim();

// ── helpers ────────────────────────────────────────────────────────────────

function stripHtml(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/<[^>]+>/g, '').trim();
}

async function getTab() {
  const tab = await browser.findTab({ urlMatch: /strava.com/ });
  if (!tab) cli.die('open strava.com in your browser first', { prefix: 'strava' });
  return tab;
}

async function apiFetch(tab, path, opts = {}) {
  const url = `https://www.strava.com${path}`;
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*',
    ...(opts.headers || {}),
  };
  const res = await browser.fetch(tab, url, { ...opts, headers });

  if (res.status === 401 || res.status === 403) {
    cli.die('session expired — log in to strava.com in your browser, then retry', { prefix: 'strava' });
  }
  if (!res.ok) {
    cli.die(`strava returned ${res.status} for ${path}`, { prefix: 'strava' });
  }
  return res.body;
}

// ── formatters ─────────────────────────────────────────────────────────────

function formatActivityType(type) {
  const icons = {
    Ride: '🚴', Run: '🏃', Swim: '🏊', Walk: '🚶', Hike: '🥾',
    VirtualRide: '🖥️', VirtualRun: '🖥️', WeightTraining: '🏋️',
    Yoga: '🧘', Workout: '💪', EBikeRide: '⚡',
  };
  return icons[type] || '🏅';
}

function formatFeedEntry(entry) {
  const act = entry.activity;
  if (!act) return null;

  const name   = c.cyan(c.bold(act.activityName || 'Activity'));
  const type   = act.type || '';
  const icon   = formatActivityType(type);
  const id     = act.id || '';

  // Parse stats (may contain HTML)
  const stats  = (act.stats || []).map(s => stripHtml(s.value));
  const [dist, time, elev] = stats;

  // Athlete name
  const athlete = entry.viewingAthlete
    ? c.dim(`${entry.viewingAthlete.name}`)
    : '';

  // Description / weather snippet
  const desc = act.description
    ? c.dim(fmt.trunc(stripHtml(act.description), 60))
    : '';

  const parts = [`  ${icon} ${name}`];

  const metaParts = [];
  if (athlete) metaParts.push(athlete);
  if (type)    metaParts.push(c.gray(type));
  if (id)      metaParts.push(c.dim(`id:${id}`));
  if (metaParts.length) parts.push(`     ${metaParts.join('  ·  ')}`);

  const statParts = [];
  if (dist) statParts.push(`${c.green(dist)}`);
  if (time) statParts.push(`${c.green(time)}`);
  if (elev) statParts.push(`${c.green(elev)} elev`);
  if (statParts.length) parts.push(`     ${statParts.join('   ')}`);

  if (desc) parts.push(`     ${desc}`);

  return parts.join('\n');
}

// ── subcommands ────────────────────────────────────────────────────────────

async function cmdMe(tab, flags) {
  const data = await apiFetch(tab, '/frontend/athletes/current');
  if (flags.json) { cli.out(data); return; }

  const a = data.currentAthlete || data;
  console.log('');
  console.log(c.bold(c.cyan(`  ${a.firstname || ''} ${a.lastname || a.name || 'Athlete'}`)));
  console.log(`  ${c.dim('ID:')}        ${a.id}`);
  if (a.gender)           console.log(`  ${c.dim('Gender:')}    ${a.gender}`);
  if (a.measurement_units)console.log(`  ${c.dim('Units:')}     ${a.measurement_units}`);
  if (a.is_subscriber)    console.log(`  ${c.dim('Plan:')}      ${c.green('Summit')}`);
  console.log('');
}

async function cmdFeed(tab, flags) {
  const limit    = parseInt(flags.limit || flags.l || 10, 10);
  const feedType = flags.following ? 'following' : 'my_activity';
  const path     = `/dashboard/feed?feed_type=${feedType}&num_entries=${Math.min(limit, 50)}`;

  const data = await apiFetch(tab, path);
  if (flags.json) { cli.out(data); return; }

  const entries = data.entries || [];
  const activities = entries.filter(e => e.entity === 'Activity' || e.activity);

  if (!activities.length) {
    console.log(c.dim('  No activities found.'));
    return;
  }

  const label = flags.mine ? 'Your Activities' : 'Activity Feed';
  console.log('');
  console.log(c.bold(`  ${label}`) + c.dim(`  (${activities.length} entries)`));
  console.log(c.dim('  ' + '─'.repeat(52)));

  for (const entry of activities) {
    const formatted = formatFeedEntry(entry);
    if (formatted) {
      console.log(formatted);
      console.log('');
    }
  }
}

async function cmdPrs(tab, flags) {
  // Use the configured athlete ID or fetch it first
  let athleteId = '292322';
  try {
    const me = await apiFetch(tab, '/frontend/athletes/current');
    if (me && me.id) athleteId = me.id;
  } catch (_) {}

  const data = await apiFetch(tab, `/athletes/${athleteId}/prs`);
  if (flags.json) { cli.out(data); return; }

  // The PRs endpoint may return HTML or structured JSON depending on the session
  if (typeof data === 'string') {
    // Try to parse useful info from HTML response
    console.log(c.dim('  (PRs returned HTML — try viewing strava.com/athletes/' + athleteId + '/prs)'));
    return;
  }

  const prs = Array.isArray(data) ? data : (data.prs || data.efforts || []);
  if (!prs.length) {
    console.log(c.dim('  No personal records found.'));
    return;
  }

  console.log('');
  console.log(c.bold('  Personal Records'));
  console.log(c.dim('  ' + '─'.repeat(52)));

  for (const pr of prs) {
    const name  = c.cyan(pr.segment_name || pr.name || 'Segment');
    const time  = pr.elapsed_time_raw
      ? c.green(fmt.trunc(String(pr.elapsed_time_raw), 20))
      : '';
    const dist  = pr.distance
      ? c.green(pr.distance)
      : '';
    const date  = pr.start_date_local
      ? c.dim(fmt.date(pr.start_date_local, 'short'))
      : '';

    const parts = [name];
    if (time) parts.push(time);
    if (dist) parts.push(dist);
    if (date) parts.push(date);

    console.log(`  ${parts.join('  ·  ')}`);
  }
  console.log('');
}

async function cmdActivity(tab, actId, flags) {
  if (!actId) cli.die('usage: strava activity <id>', { prefix: 'strava' });

  // Try the internal activity JSON endpoint first
  const path = `/activities/${actId}`;
  const res = await browser.fetch(tab, `https://www.strava.com${path}`, {
    headers: {
      'Accept': 'application/json, text/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!res.ok) {
    cli.die(`could not load activity ${actId} (status ${res.status})`, { prefix: 'strava' });
  }

  const data = res.body;
  if (flags.json) { cli.out(data); return; }

  // data may be JSON or HTML — handle both
  if (data && typeof data === 'object') {
    const a = data;
    console.log('');
    console.log(c.bold(c.cyan(`  ${a.name || a.activityName || 'Activity'}`)));
    if (a.type)        console.log(`  ${c.dim('Type:')}        ${a.type}`);
    if (a.distance)    console.log(`  ${c.dim('Distance:')}    ${stripHtml(String(a.distance))}`);
    if (a.moving_time) console.log(`  ${c.dim('Time:')}        ${a.moving_time}`);
    if (a.total_elevation_gain)
                       console.log(`  ${c.dim('Elevation:')}   ${a.total_elevation_gain} m`);
    if (a.start_date_local)
                       console.log(`  ${c.dim('Date:')}        ${fmt.date(a.start_date_local, 'medium')}`);
    if (a.description) console.log(`  ${c.dim('Notes:')}       ${stripHtml(a.description)}`);
    console.log('');
  } else {
    // Fallback: try extracting from the feed approach — tell user to use feed
    console.log(c.dim(`  Activity ${actId} loaded — use --json to see raw data`));
    console.log(c.dim(`  Or visit: https://www.strava.com/activities/${actId}`));
  }
}

async function cmdNotifications(tab, flags) {
  const data = await apiFetch(tab, '/frontend/athlete/notifications/num_new_notifications');
  if (flags.json) { cli.out(data); return; }

  const count = data.num_new_notifications ?? data.count ?? data;
  const n = parseInt(count, 10);

  console.log('');
  if (isNaN(n) || n === 0) {
    console.log(`  ${c.dim('Notifications:')}  ${c.gray('none')}`);
  } else {
    console.log(`  ${c.dim('Notifications:')}  ${c.bold(c.green(String(n)))} new`);
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

const { positional, flags, subcommand } = process.argv.parseFlags();
const cmd = subcommand || positional[0];

if (flags.help || flags.h || cmd === '--help' || cmd === 'help' || !cmd) {
  cli.help(HELP);
  process.exit(0);
}

const tab = await getTab();

if (cmd === 'me') {
  await cmdMe(tab, flags);
} else if (cmd === 'feed') {
  await cmdFeed(tab, flags);
} else if (cmd === 'prs') {
  await cmdPrs(tab, flags);
} else if (cmd === 'activity') {
  const actId = positional[1] || positional[0] !== 'activity' && positional[0];
  await cmdActivity(tab, actId, flags);
} else if (cmd === 'notifications' || cmd === 'notifs' || cmd === 'notify') {
  await cmdNotifications(tab, flags);
} else {
  cli.die(`unknown command: ${cmd}\nRun 'strava --help' for usage.`, { prefix: 'strava' });
}
