// garmin.jsh — Garmin Connect CLI (DI OAuth2 Bearer token against connectapi.garmin.com)

// ─── Constants ───────────────────────────────────────────────────────────────

const CLIENT_ID   = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2';
const TOKEN_URL   = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const API_BASE    = 'https://connectapi.garmin.com';
const GRANT_TYPE  = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
const SERVICE_URL = 'https://connect.garmin.com/modern';

const SSO_URL =
  'https://sso.garmin.com/sso/signin' +
  '?id=gauth-widget' +
  '&clientId=GarminConnect' +
  '&locale=en' +
  `&service=${encodeURIComponent(SERVICE_URL)}` +
  `&webhost=${encodeURIComponent(SERVICE_URL)}` +
  `&redirectAfterAccountLoginUrl=${encodeURIComponent(SERVICE_URL)}` +
  `&redirectAfterAccountCreationUrl=${encodeURIComponent(SERVICE_URL)}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return c.dim('—');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDistance(meters) {
  if (!meters && meters !== 0) return c.dim('—');
  return `${(meters / 1000).toFixed(2)} km`;
}

function fmtElevation(meters) {
  if (!meters && meters !== 0) return c.dim('—');
  return `${Math.round(meters)} m`;
}

function fmtDate(isoStr) {
  if (!isoStr) return c.dim('—');
  const d = new Date(isoStr);
  return fmt.date(d, 'short');
}

function fmtActivityType(a) {
  const raw = a.activityType?.typeKey || a.activityType?.typeId || '?';
  return String(raw).replace(/_/g, ' ');
}

// ─── Token management ────────────────────────────────────────────────────────

async function loadConfig() {
  return skill.config() || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

async function exchangeTicket(ticket) {
  const body = new URLSearchParams({
    grant_type:     GRANT_TYPE,
    client_id:      CLIENT_ID,
    service_ticket: ticket,
    service_url:    SERVICE_URL,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    cli.die(`Token exchange failed (${res.status}): ${text}`, { prefix: 'garmin' });
  }

  return await res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Refresh failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

/** Returns a valid access token, refreshing if needed. Throws if unable. */
async function getAccessToken() {
  const cfg = await loadConfig();

  if (!cfg.access_token) {
    cli.die('Not logged in. Run: garmin login', { prefix: 'garmin' });
  }

  const now = Date.now();

  // Access token still valid?
  if (cfg.expires_at && now < cfg.expires_at - 60_000) {
    return cfg.access_token;
  }

  // Refresh token expired?
  if (cfg.refresh_token_expires_at && now >= cfg.refresh_token_expires_at) {
    cli.die('Refresh token expired. Run: garmin login', { prefix: 'garmin' });
  }

  // Try refreshing
  cli.warn('Access token expired — refreshing…');
  try {
    const tok = await refreshAccessToken(cfg.refresh_token);
    const updates = {
      access_token:  tok.access_token,
      expires_at:    Date.now() + (tok.expires_in || 93600) * 1000,
    };
    if (tok.refresh_token) {
      updates.refresh_token = tok.refresh_token;
      updates.refresh_token_expires_at = Date.now() + 30 * 24 * 60 * 60 * 1000;
    }
    await saveConfig(updates);
    return updates.access_token;
  } catch (err) {
    cli.die(`Could not refresh token: ${err.message}\nRun: garmin login`, { prefix: 'garmin' });
  }
}

/** Build a configured http.client for connectapi.garmin.com */
async function apiClient() {
  const token = await getAccessToken();
  return http.client({
    baseUrl: API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/json',
      'NK':          'NT',
    },
    retry: { on: [429, 503], attempts: 3, backoff: 'exponential' },
  });
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function cmdLogin() {
  console.log(c.cyan('Opening Garmin SSO login…'));
  console.log(c.dim('A browser tab will open. Sign in, then come back here.'));

  const { stdout, stderr, exitCode } = await exec(
    `oauth-token --intercept \
      --authorize-url ${JSON.stringify(SSO_URL)} \
      --redirect-pattern "https://connect.garmin.com/modern*"`
  );

  if (exitCode !== 0) {
    cli.die(`oauth-token intercept failed:\n${stderr}`, { prefix: 'garmin' });
  }

  // Extract redirect URL from stdout — it should contain the full redirect
  const redirectUrl = stdout.trim();
  const match = redirectUrl.match(/ticket=([^&\s]+)/);
  if (!match) {
    cli.die(
      `Could not find ticket in redirect URL.\nGot: ${redirectUrl}`,
      { prefix: 'garmin' }
    );
  }

  const ticket = match[1];
  console.log(c.dim(`Ticket: ${ticket.substring(0, 20)}…`));
  console.log(c.cyan('Exchanging ticket for Bearer token…'));

  const tok = await exchangeTicket(ticket);

  const updates = {
    access_token:              tok.access_token,
    refresh_token:             tok.refresh_token,
    expires_at:                Date.now() + (tok.expires_in  || 93600) * 1000,
    refresh_token_expires_at:  Date.now() + 30 * 24 * 60 * 60 * 1000,
  };

  // Fetch the user's social profile GUID for later use
  try {
    const client = http.client({
      baseUrl: API_BASE,
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', NK: 'NT' },
    });
    const profile = await client.get('/userprofile-service/socialProfile');
    if (profile?.userProfileId) updates.garmin_guid = String(profile.userProfileId);
    else if (profile?.displayName) updates.garmin_guid = profile.displayName;
  } catch { /* non-fatal — profile commands will prompt */ }

  await saveConfig(updates);

  console.log(c.green('✓ Logged in to Garmin Connect'));
  console.log(c.dim(`  Access token valid for ~${Math.round((tok.expires_in || 93600) / 3600)} hours`));
  console.log(c.dim('  Refresh token valid for 30 days'));
}

async function cmdActivities(flags) {
  const limit  = parseInt(flags.limit  ?? flags.l ?? 20, 10);
  const start  = parseInt(flags.start  ?? flags.s ?? 0,  10);
  const asJson = !!(flags.json);

  const client = await apiClient();
  const data   = await client.get(
    `/activitylist-service/activities/search/activities?limit=${limit}&start=${start}`
  );

  if (asJson) {
    cli.out(data);
    return;
  }

  const activities = Array.isArray(data) ? data : (data.activityList || data.activities || []);

  if (!activities.length) {
    console.log(c.dim('No activities found.'));
    return;
  }

  console.log(c.bold(c.cyan(`\n  Garmin Activities (${activities.length})\n`)));

  const header = [
    fmt.col(c.bold('Date'),     12),
    fmt.col(c.bold('Name'),     28),
    fmt.col(c.bold('Type'),     18),
    fmt.col(c.bold('Distance'), 12),
    fmt.col(c.bold('Duration'),  10),
    fmt.col(c.bold('Elevation'), 10),
  ].join('  ');
  console.log('  ' + header);
  console.log('  ' + c.dim('─'.repeat(94)));

  for (const a of activities) {
    const row = [
      fmt.col(c.gray(fmtDate(a.startTimeLocal || a.startTimeGMT)), 12),
      fmt.col(fmt.trunc(a.activityName || c.dim('—'), 27), 28),
      fmt.col(c.dim(fmtActivityType(a)), 18),
      fmt.col(c.green(fmtDistance(a.distance)), 12),
      fmt.col(c.yellow(fmtDuration(a.duration)), 10),
      fmt.col(c.dim(fmtElevation(a.elevationGain)), 10),
    ].join('  ');
    console.log('  ' + row);
  }

  console.log();
  if (activities.length === limit) {
    console.log(c.dim(`  Showing ${start}–${start + limit}. Use --start ${start + limit} to load more.`));
  }
}

async function cmdActivity(id, flags) {
  if (!id) cli.die('Usage: garmin activity <id>', { prefix: 'garmin' });

  const client = await apiClient();
  const data   = await client.get(`/activity-service/activity/${id}`);

  if (flags.json) {
    cli.out(data);
    return;
  }

  const a = data;
  console.log(c.bold(c.cyan(`\n  ${a.activityName || 'Activity'}`)));
  console.log(c.dim(`  ID: ${a.activityId}`));
  console.log();

  const info = [
    ['Date',          fmtDate(a.startTimeLocal || a.startTimeGMT)],
    ['Type',          fmtActivityType(a)],
    ['Distance',      fmtDistance(a.distance)],
    ['Duration',      fmtDuration(a.duration)],
    ['Moving Time',   fmtDuration(a.movingDuration)],
    ['Elevation Gain',fmtElevation(a.elevationGain)],
    ['Elevation Loss',fmtElevation(a.elevationLoss)],
    ['Avg HR',        a.averageHR  ? `${Math.round(a.averageHR)} bpm`  : c.dim('—')],
    ['Max HR',        a.maxHR      ? `${Math.round(a.maxHR)} bpm`      : c.dim('—')],
    ['Avg Speed',     a.averageSpeed ? `${(a.averageSpeed * 3.6).toFixed(1)} km/h` : c.dim('—')],
    ['Calories',      a.calories   ? `${Math.round(a.calories)} kcal`  : c.dim('—')],
    ['Steps',         a.steps      ? String(a.steps)                    : c.dim('—')],
    ['Avg Cadence',   a.averageRunningCadenceInStepsPerMinute
                        ? `${Math.round(a.averageRunningCadenceInStepsPerMinute)} spm`
                        : c.dim('—')],
    ['Avg Power',     a.avgPower   ? `${Math.round(a.avgPower)} W`     : c.dim('—')],
    ['Location',      a.locationName || c.dim('—')],
    ['Description',   a.description  || c.dim('—')],
  ];

  for (const [label, value] of info) {
    console.log(`  ${c.gray(fmt.col(label + ':', 18))} ${value}`);
  }
  console.log();
}

async function cmdDevices(flags) {
  const client = await apiClient();
  const data   = await client.get('/device-service/deviceregistration/devices');

  if (flags.json) {
    cli.out(data);
    return;
  }

  const devices = Array.isArray(data) ? data : (data.devices || data.deviceRegistrations || []);

  if (!devices.length) {
    console.log(c.dim('No registered devices found.'));
    return;
  }

  console.log(c.bold(c.cyan(`\n  Registered Garmin Devices (${devices.length})\n`)));

  for (const d of devices) {
    const name    = d.productDisplayName || d.deviceType?.displayName || d.modelName || 'Unknown';
    const serial  = d.serialNumber   || c.dim('—');
    const version = d.currentFirmwareVersion || d.firmwareVersion || c.dim('—');
    const lastSync= d.lastMessageReceived || d.lastSynced || null;

    console.log(`  ${c.bold(name)}`);
    console.log(`    ${c.gray('Serial:')}   ${serial}`);
    console.log(`    ${c.gray('Firmware:')} ${version}`);
    if (lastSync) {
      console.log(`    ${c.gray('Last sync:')} ${fmtDate(lastSync)}`);
    }
    if (d.deviceId) {
      console.log(`    ${c.gray('Device ID:')} ${c.dim(String(d.deviceId))}`);
    }
    console.log();
  }
}

async function cmdProfile(flags) {
  const cfg    = await loadConfig();
  const guid   = cfg.garmin_guid;
  if (!guid) cli.die('No profile GUID stored. Run: garmin login', { prefix: 'garmin' });
  const client = await apiClient();

  const [social, personal] = await Promise.all([
    client.get(`/userprofile-service/socialProfile/${guid}`).catch(() => null),
    client.get(`/userprofile-service/userprofile/personal-information/${guid}`).catch(() => null),
  ]);

  if (flags.json) {
    cli.out({ social, personal });
    return;
  }

  const s = social   || {};
  const p = personal || {};

  console.log(c.bold(c.cyan('\n  Garmin Profile\n')));

  const displayName = s.displayName || s.userName || p.displayName || c.dim('—');
  const fullName    = [s.firstName, s.lastName].filter(Boolean).join(' ') || c.dim('—');
  const location    = s.location || c.dim('—');
  const joined      = s.memberSince ? fmtDate(s.memberSince) : c.dim('—');
  const followers   = s.followerCount != null ? String(s.followerCount) : c.dim('—');
  const following   = s.followingCount != null ? String(s.followingCount) : c.dim('—');

  const rows = [
    ['Display Name', displayName],
    ['Full Name',    fullName],
    ['Location',     location],
    ['Member Since', joined],
    ['Followers',    followers],
    ['Following',    following],
    ['GUID',         c.dim(guid)],
  ];

  for (const [label, value] of rows) {
    console.log(`  ${c.gray(fmt.col(label + ':', 16))} ${value}`);
  }

  // Personal info extras
  if (p.biometricProfile) {
    const b = p.biometricProfile;
    console.log();
    console.log(c.bold('  Biometrics'));
    if (b.height) console.log(`  ${c.gray(fmt.col('Height:', 16))} ${b.height} cm`);
    if (b.weight) console.log(`  ${c.gray(fmt.col('Weight:', 16))} ${(b.weight / 1000).toFixed(1)} kg`);
    if (b.vo2Max) console.log(`  ${c.gray(fmt.col('VO2 Max:', 16))} ${b.vo2Max}`);
  }

  console.log();
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  cli.help(`
${c.bold(c.cyan('garmin'))} — Garmin Connect CLI

${c.bold('USAGE')}
  garmin <command> [options]

${c.bold('COMMANDS')}
  ${c.cyan('login')}                        Authenticate via SSO intercept
  ${c.cyan('activities')}                   List recent Garmin activities
    ${c.gray('--limit N')}   (default 20)   Number of activities to fetch
    ${c.gray('--start N')}   (default 0)    Pagination offset
    ${c.gray('--json')}                     Output raw JSON
  ${c.cyan('activity <id>')}               Show single activity details
    ${c.gray('--json')}                     Output raw JSON
  ${c.cyan('devices')}                      List registered Garmin devices
    ${c.gray('--json')}                     Output raw JSON
  ${c.cyan('profile')}                      Show Garmin user profile
    ${c.gray('--json')}                     Output raw JSON
  ${c.cyan('--help')}                       Show this help

${c.bold('EXAMPLES')}
  garmin login
  garmin activities --limit 10
  garmin activities --start 20 --limit 5
  garmin activity 12345678901
  garmin devices
  garmin profile
  garmin activities --json | jq '.[0]'

${c.bold('AUTH')}
  Run ${c.cyan('garmin login')} once. Tokens are stored in skill config.
  Access token refreshes automatically (~26 h). Re-login after 30 days.
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const { positional, flags, subcommand } = process.argv.parseFlags();
const cmd = subcommand || positional[0];

if (!cmd || flags.help || flags.h) {
  showHelp();
  process.exit(0);
}

try {
  switch (cmd) {
    case 'login':
      await cmdLogin();
      break;

    case 'activities':
      await cmdActivities(flags);
      break;

    case 'activity':
      await cmdActivity(positional[1], flags);
      break;

    case 'devices':
      await cmdDevices(flags);
      break;

    case 'profile':
      await cmdProfile(flags);
      break;

    default:
      cli.die(`Unknown command: ${cmd}\nRun: garmin --help`, { prefix: 'garmin' });
  }
} catch (err) {
  if (err?.status === 401) {
    cli.die('Authentication error (401). Run: garmin login', { prefix: 'garmin' });
  } else if (err?.status === 403) {
    cli.die('Access denied (403). Your token may lack permissions.', { prefix: 'garmin' });
  } else if (err?.status === 404) {
    cli.die(`Not found (404): ${err.message}`, { prefix: 'garmin' });
  } else if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
    cli.die(`Network error: ${err.message}`, { prefix: 'garmin' });
  } else {
    cli.die(err?.message || String(err), { prefix: 'garmin' });
  }
}
