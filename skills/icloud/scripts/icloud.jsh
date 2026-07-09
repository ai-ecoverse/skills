/**
 * icloud.jsh — iCloud CLI for SLICC
 *
 * Access iCloud Calendar and Notes via the iCloud web APIs.
 * Requires an open, authenticated iCloud tab at icloud.com.
 * Uses page-context fetch (via the `sliccy:browser` bridge) to handle authentication.
 *
 * Usage:
 *   icloud calendar [--date 2d|7d|14d|30d] [--json]
 *   icloud calendar create --title "..." --start "..." --end "..." [--location "..."]
 *   icloud calendar create --from-json   # reads shared-schema JSON from stdin
 *   icloud notes [--search "query"] [--json]
 *   icloud notes read <note-id> [--json]
 *   icloud --help
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ MIGRATION NOTES (issue #118 / ai-ecoverse/slicc#786)                        │
 * │                                                                             │
 * │ The .jsh runtime no longer injects bare globals (`exec`, `fmt`, `cli`,      │
 * │ `fs`, ...) — they must be pulled in explicitly via require('sliccy:<name>').│
 * │ This script's logic is otherwise unchanged; only the following moved:      │
 * │                                                                             │
 * │  • const fmt  = require('sliccy:fmt');   — replaces the hand-rolled       │
 * │    col()/pad() helper with fmt.col(str, width) (same signature/behavior). │
 * │                                                                             │
 * │  • Tab discovery + in-page fetch: previously shelled out to               │
 * │    `playwright-cli tab-list` / `eval` via the bare `exec()` global and     │
 * │    regex-parsed the CLI output (including a fragile double-JSON-decode    │
 * │    of the eval return value). Replaced with the dedicated `sliccy:browser` │
 * │    bridge: `browser.findTab({ domain })` for tab discovery, and            │
 * │    `browser.evalAsync(tab, fn)` for in-page async evaluation (session      │
 * │    discovery, batch note decoding, note-content decompression) — no more   │
 * │    manual shell-quoting of JS source or exec() at all, so `sliccy:exec`    │
 * │    isn't needed by this file.                                              │
 * │                                                                             │
 * │  • const cli = require('sliccy:cli'); — every `console.error(msg) +       │
 * │    process.exit(1)` pair (usage errors, auth errors, API errors) is       │
 * │    replaced 1:1 with `cli.die(msg, { prefix: '' })`. `cli.die` defaults   │
 * │    to prepending "Error: " to the message; `{ prefix: '' }` suppresses    │
 * │    that so stderr text stays byte-for-byte identical to the original      │
 * │    bare `console.error(...)` output. The top-level `--help`/`-h`/         │
 * │    no-args path uses `cli.help(text)` instead of `console.log(text);      │
 * │    process.exit(0)` — same text, same exit code 0.                        │
 * │                                                                             │
 * │  • const fs = require('fs'); — used for `--from-json <file>` reads;        │
 * │    calls are already `await`ed as required by the new async-only bridge.  │
 * │                                                                             │
 * │  • `process.argv.parseFlags()` is now a real bare global; the             │
 * │    hand-rolled parseFlags() helper was removed and both call sites        │
 * │    (calendar/notes) read `{ flags, positional }` from it, slicing the     │
 * │    leading subcommand off `positional` to preserve prior arg semantics.   │
 * │                                                                             │
 * │ No subcommands, flags, output formatting, or behavior were changed.       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */

const fs = require('fs');
const browser = require('sliccy:browser');
const fmt = require('sliccy:fmt');
const cli = require('sliccy:cli');

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  cli.help(usageText());
}

const subcommand = args[0];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usageText() {
  return `icloud — iCloud Calendar & Notes CLI for SLICC

Usage:
  icloud calendar [--date 2d|7d|14d|30d] [--json]
  icloud calendar create --title "..." --start "..." --end "..." [--location "..."]
  icloud calendar create --from-json [FILE]
  icloud notes [--search "query"] [--json]
  icloud notes read <note-id> [--json]
  icloud --help

Calendar:
  Lists upcoming events. Default range is 7 days.
  --date    Range: 1d, 2d, 7d, 14d, 30d (default: 7d)
  --json    Output shared-schema JSON
  --raw-json Output raw iCloud API JSON

Calendar create:
  --title TEXT       Event title
  --start DATETIME   Start (e.g. 2026-05-28T15:00)
  --end DATETIME     End (e.g. 2026-05-28T16:00)
  --location TEXT    Optional location
  --calendar NAME    Calendar name (default: first/home calendar)
  --block            Privacy mode: title="Blocked"
  --from-json [FILE] Read events from stdin or file (shared schema)

Piping:
  outlook calendar --json | icloud calendar create --from-json
  icloud calendar --json | outlook calendar create --from-json --block

Notes:
  Lists recent notes (title + snippet).
  --search  Filter notes by title/snippet text
  --json    Output raw JSON

  icloud notes read <note-id>
    Reads the full content of a note by its ID.`;
}

function printUsage() {
  console.log(usageText());
}

function fmtDate(dateArr) {
  if (!dateArr || dateArr.length < 4) return '';
  const y = dateArr[1];
  const m = String(dateArr[2]).padStart(2, '0');
  const d = String(dateArr[3]).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtTime(dateArr) {
  if (!dateArr || dateArr.length < 6) return '';
  const h = String(dateArr[4]).padStart(2, '0');
  const min = String(dateArr[5]).padStart(2, '0');
  return `${h}:${min}`;
}

function fmtDateTime(dateArr) {
  const d = fmtDate(dateArr);
  const t = fmtTime(dateArr);
  if (!t) return d;
  return `${d} ${t}`;
}

function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function normalizeDateTime(dt) {
  if (!dt) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) dt += ':00';
  return dt;
}

// ─── Shared Event Schema ─────────────────────────────────────────────────────

function icloudEventToShared(ev) {
  const startArr = ev.localStartDate || ev.startDate || [];
  const endArr = ev.localEndDate || ev.endDate || [];

  function arrToISO(arr) {
    if (!arr || arr.length < 5) return '';
    const y = arr[1];
    const m = String(arr[2]).padStart(2, '0');
    const d = String(arr[3]).padStart(2, '0');
    const h = String(arr[4]).padStart(2, '0');
    const min = String(arr[5] || 0).padStart(2, '0');
    const sec = String(arr[6] || 0).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}:${sec}`;
  }

  return {
    title: ev.title || '',
    start: arrToISO(startArr),
    end: arrToISO(endArr),
    location: ev.location || '',
    allDay: !!ev.allDay,
    description: ev.description || '',
    busy: true, // iCloud doesn't expose free/busy easily; default busy
  };
}

// ─── iCloud Tab Management ───────────────────────────────────────────────────

async function getICloudTab() {
  // NOTE: browser.findTab's `domain` option requires an exact hostname match.
  // Navigating to icloud.com always lands on www.icloud.com (redirect), so
  // `{ domain: 'icloud.com' }` never matches a real tab — confirmed live
  // against an authenticated www.icloud.com session, which this fails to
  // find. The pre-migration exec('playwright-cli tab-list') + regex approach
  // did a plain substring match against the full tab URL, so it matched
  // www.icloud.com fine; `urlMatch` (substring/regex against the full URL)
  // is the bridge's equivalent and is used here to restore that behavior.
  const tab = await browser.findTab({ urlMatch: /icloud\.com/ });
  if (tab) return tab;

  cli.die('No iCloud tab found. Please open https://www.icloud.com/ and sign in.', { prefix: '' });
}

// ─── iCloud Session Discovery ────────────────────────────────────────────────

async function getSession(tab) {
  let parsed;
  try {
    parsed = await browser.evalAsync(tab, async () => {
      try {
        const resp = await fetch("https://setup.icloud.com/setup/ws/1/validate?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "text/plain", "Origin": "https://www.icloud.com" }
        });
        if (!resp.ok) return { error: "VALIDATE_FAILED", status: resp.status };
        const data = await resp.json();
        return {
          dsid: data.dsInfo ? data.dsInfo.dsid : null,
          calendarUrl: data.webservices && data.webservices.calendar ? data.webservices.calendar.url : null,
          ckdbUrl: data.webservices && data.webservices.ckdatabasews ? data.webservices.ckdatabasews.url : null
        };
      } catch(e) {
        return { error: "SESSION_ERROR", message: e.message };
      }
    });
  } catch (e) {
    cli.die('Failed to get iCloud session: ' + e.message, { prefix: '' });
  }

  if (parsed.error) {
    console.error(`iCloud session error: ${parsed.error} — ${parsed.message || ''}`);
    cli.die('Please ensure you are signed in at https://www.icloud.com/', { prefix: '' });
  }

  return parsed;
}

// ─── Generic Page-Context Fetch ──────────────────────────────────────────────

async function icloudFetch(tab, url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : null;

  // NOTE: must be an invoked IIFE ("(async () => {...})()"), not a bare
  // function expression. browser.evalAsync does not auto-invoke a string
  // argument the way it does when handed a real Function object — a bare
  // "async () => {...}" string evaluates to a Function value, which
  // serializes to "{}" with no error, silently swallowing every fetch made
  // through this helper. Confirmed live: this exact bug caused `icloud
  // calendar` to fail with "Calendar API error (HTTP undefined)" even
  // against a real, authenticated session.
  const fnSource = `(async () => {
    try {
      const resp = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: "include",
        headers: { "Content-Type": "text/plain", "Origin": "https://www.icloud.com" }${body ? `,\n        body: ${JSON.stringify(body)}` : ''}
      });
      const status = resp.status;
      if (status === 204) return { status: 204, ok: true, data: null };
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch(e) { data = text; }
      return { status, ok: resp.ok, data };
    } catch(e) {
      return { error: "FETCH_ERROR", message: e.message };
    }
  })()`;

  let parsed;
  try {
    parsed = await browser.evalAsync(tab, fnSource);
  } catch (e) {
    cli.die('eval failed: ' + e.message, { prefix: '' });
  }

  if (parsed.error === 'FETCH_ERROR') {
    cli.die('Fetch error: ' + parsed.message, { prefix: '' });
  }
  if (parsed.status === 401 || parsed.status === 403) {
    cli.die(`Authentication error (HTTP ${parsed.status}). Your iCloud session may have expired.`, { prefix: '' });
  }

  return parsed;
}

// ─── Calendar Commands ───────────────────────────────────────────────────────

async function cmdCalendar() {
  const { flags, positional: allPositional } = process.argv.parseFlags();
  const positional = allPositional.slice(1);

  // Check for "create" subcommand
  if (positional[0] === 'create') {
    await cmdCalendarCreate(flags, positional.slice(1));
    return;
  }

  const jsonOutput = !!flags.json;
  const rawJson = !!flags['raw-json'];

  // Parse date range
  const rangeStr = flags.date || '7d';
  const rangeMatch = rangeStr.match(/^(\d+)d$/);
  if (!rangeMatch) {
    cli.die('Invalid --date format. Use: 1d, 2d, 7d, 14d, 30d', { prefix: '' });
  }
  const days = parseInt(rangeMatch[1]);

  const tab = await getICloudTab();
  const session = await getSession(tab);

  const now = new Date();
  const startDate = now.toISOString().split('T')[0];
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const endDate = end.toISOString().split('T')[0];

  const url = `${session.calendarUrl}/ca/events?startDate=${startDate}&endDate=${endDate}&lang=en-us&usertz=Europe%2FBerlin&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;

  const resp = await icloudFetch(tab, url);

  if (!resp.ok) {
    cli.die(`Calendar API error (HTTP ${resp.status})`, { prefix: '' });
  }

  const events = (resp.data && resp.data.Event) || [];

  if (rawJson) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (jsonOutput) {
    // Output in shared schema format
    const shared = events.map(icloudEventToShared);
    console.log(JSON.stringify(shared, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log(`No events in the next ${days} day${days !== 1 ? 's' : ''}.`);
    return;
  }

  // Sort events by start date
  events.sort((a, b) => {
    const aStart = a.localStartDate ? a.localStartDate[0] * 10000 + a.localStartDate[4] * 60 + a.localStartDate[5] : 0;
    const bStart = b.localStartDate ? b.localStartDate[0] * 10000 + b.localStartDate[4] * 60 + b.localStartDate[5] : 0;
    return aStart - bStart;
  });

  console.log(`Events: ${startDate} to ${endDate} (${days}d)\n`);
  console.log(fmt.col('Date', 12) + fmt.col('Time', 14) + fmt.col('Title', 40) + 'Location');
  console.log('-'.repeat(90));

  let lastDate = '';
  for (const ev of events) {
    const date = fmtDate(ev.localStartDate);
    const startTime = ev.allDay ? 'all-day' : fmtTime(ev.localStartDate);
    const endTime = ev.allDay ? '' : fmtTime(ev.localEndDate);
    const timeStr = ev.allDay ? 'all-day' : `${startTime}-${endTime}`;
    const displayDate = date === lastDate ? '' : date;
    lastDate = date;

    console.log(
      fmt.col(displayDate, 12) +
      fmt.col(timeStr, 14) +
      fmt.col(ev.title || '(no title)', 40) +
      (ev.location || '')
    );
  }

  console.log(`\n${events.length} event${events.length !== 1 ? 's' : ''}.`);
}

// ─── Calendar Create ─────────────────────────────────────────────────────────

async function cmdCalendarCreate(flags, positional) {
  const tab = await getICloudTab();
  const session = await getSession(tab);

  // Discover calendars via /ca/allcollections to get GUIDs and ctags
  const calendarName = flags.calendar || null;
  let calendarGuid = null;
  let calendarCtag = null;

  const now = new Date();
  const colStart = now.toISOString().slice(0, 10);
  const colEnd = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const collectionsUrl = `${session.calendarUrl}/ca/allcollections?startDate=${colStart}&endDate=${colEnd}&usertz=Europe%2FBerlin&lang=en-US&clientVersion=6.0&requestID=1&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
  const colResp = await icloudFetch(tab, collectionsUrl);

  if (colResp.ok && colResp.data && colResp.data.Collection) {
    const collections = colResp.data.Collection;
    if (calendarName) {
      const match = collections.find(c => c.title && c.title.toLowerCase().includes(calendarName.toLowerCase()));
      if (match) { calendarGuid = match.guid; calendarCtag = match.ctag || ''; }
    }
    if (!calendarGuid) {
      // Default to "work" or first non-delegate
      const work = collections.find(c => c.guid === 'work');
      const fallback = work || collections[0];
      if (fallback) { calendarGuid = fallback.guid; calendarCtag = fallback.ctag || ''; }
    }
  }

  if (!calendarGuid) {
    cli.die('Could not determine target calendar. Ensure iCloud Calendar is accessible.', { prefix: '' });
  }

  // Determine event source: --from-json or flags
  let events = [];

  if (flags['from-json'] !== undefined) {
    let jsonInput = '';
    if (typeof flags['from-json'] === 'string' && flags['from-json'] !== 'true') {
      try {
        jsonInput = await fs.readFile(flags['from-json']);
      } catch (e) {
        cli.die(`icloud calendar create: cannot read file "${flags['from-json']}": ${e.message}`, { prefix: '' });
      }
    } else {
      // Read from stdin
      try {
        jsonInput = (await process.stdin.read()) || '';
      } catch (e) {
        cli.die(`icloud calendar create: failed to read stdin: ${e.message}`, { prefix: '' });
      }
    }

    if (!jsonInput.trim()) {
      cli.die('icloud calendar create: no JSON input received', { prefix: '' });
    }

    try {
      const parsed = JSON.parse(jsonInput.trim());
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      cli.die(`icloud calendar create: invalid JSON: ${e.message}`, { prefix: '' });
    }
  } else {
    // Single event from flags
    const title = flags.title;
    const start = flags.start;
    const end = flags.end;

    if (!title) { cli.die('icloud calendar create: --title is required', { prefix: '' }); }
    if (!start) { cli.die('icloud calendar create: --start is required', { prefix: '' }); }
    if (!end) { cli.die('icloud calendar create: --end is required', { prefix: '' }); }

    events = [{
      title,
      start,
      end,
      location: flags.location || '',
      description: flags.body || '',
      allDay: flags['all-day'] === true || flags['all-day'] === 'true',
    }];
  }

  const blockMode = !!flags.block;
  let created = 0;
  let skipped = 0;

  // Check for duplicates: fetch events in the date range
  let existingEvents = [];
  if (events.length > 0) {
    const allStarts = events.map(e => normalizeDateTime(e.start)).filter(Boolean);
    if (allStarts.length > 0) {
      const minDate = allStarts.sort()[0].split('T')[0];
      const maxEnd = events.map(e => normalizeDateTime(e.end)).filter(Boolean).sort().pop() || minDate;
      const maxDate = maxEnd.split('T')[0];

      const checkUrl = `${session.calendarUrl}/ca/events?startDate=${minDate}&endDate=${maxDate}&lang=en-us&usertz=Europe%2FBerlin&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
      const checkResp = await icloudFetch(tab, checkUrl);
      if (checkResp.ok && checkResp.data && checkResp.data.Event) {
        existingEvents = checkResp.data.Event;
      }
    }
  }

  for (const ev of events) {
    const startDt = normalizeDateTime(ev.start);
    const endDt = normalizeDateTime(ev.end);

    if (!startDt || !endDt) {
      console.error(`Skipping event "${ev.title}": missing start/end`);
      skipped++;
      continue;
    }

    const eventTitle = blockMode ? 'Blocked' : (ev.title || 'Untitled');

    // Duplicate check against fetched events
    const isDup = existingEvents.some(existing => {
      const exTitle = existing.title || '';
      const exStart = icloudEventToShared(existing).start;
      return exTitle === eventTitle && exStart === startDt;
    });

    if (isDup) {
      console.log(`⊘ Skipped duplicate: "${eventTitle}" at ${startDt}`);
      skipped++;
      continue;
    }

    // Generate a new event GUID
    const newGuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Parse start/end into date arrays for iCloud API
    // Format: [yyyymmdd, yyyy, mm, dd, hh, mm, minutesFromMidnight] — 7-element array
    function parseToDateArr(dtStr) {
      const match = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, y, mo, d, h, mi] = match;
      const dateNum = parseInt(y + mo + d);
      const minsFromMidnight = parseInt(h) * 60 + parseInt(mi);
      return [dateNum, parseInt(y), parseInt(mo), parseInt(d), parseInt(h), parseInt(mi), minsFromMidnight];
    }

    const startArr = parseToDateArr(startDt);
    const endArr = parseToDateArr(endDt);

    if (!startArr || !endArr) {
      console.error(`Skipping event "${eventTitle}": invalid date format`);
      skipped++;
      continue;
    }

    // Duration in minutes
    const durationMins = (endArr[6] - startArr[6]) || 60;
    const now = new Date();
    const nowArr = [parseInt(now.toISOString().slice(0,10).replace(/-/g,'')), now.getFullYear(), now.getMonth()+1, now.getDate(), now.getHours(), now.getMinutes(), now.getHours()*60+now.getMinutes()];

    // Build the iCloud event payload (matches HAR-captured format)
    const eventPayload = {
      Event: {
        guid: newGuid,
        etag: '',
        title: eventTitle,
        location: (!blockMode && ev.location) ? ev.location : '',
        description: (!blockMode && ev.description) ? ev.description : '',
        allDay: !!ev.allDay,
        startDate: startArr,
        endDate: endArr,
        localStartDate: startArr,
        localEndDate: endArr,
        duration: durationMins,
        pGuid: calendarGuid,
        tz: 'Europe/Berlin',
        extendedDetailsAreIncluded: true,
        icon: 0,
        readOnly: false,
        birthdayIsYearlessBday: false,
        birthdayShowAsCompany: false,
        shouldShowJunkUIWhenAppropriate: false,
        recurrenceException: false,
        recurrenceMaster: false,
        hasAttachments: false,
        attachments: [],
        alarms: [],
        transparent: false,
        createdDate: nowArr,
        lastModifiedDate: nowArr,
      },
      Invitee: [],
      Alarm: [],
      ClientState: {
        Collection: [{
          guid: calendarGuid,
          ctag: calendarCtag || ''
        }]
      }
    };

    // POST to create event
    const createUrl = `${session.calendarUrl}/ca/events/${calendarGuid}/${newGuid}?startDate=${colStart}&endDate=${colEnd}&lang=en-US&usertz=Europe%2FBerlin&requestID=${created + skipped + 2}&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;

    const createResp = await icloudFetch(tab, createUrl, {
      method: 'POST',
      body: eventPayload
    });

    if (createResp.ok || createResp.status === 200 || createResp.status === 201) {
      console.log(`✓ Created: "${eventTitle}" ${startDt} → ${endDt}`);
      created++;
    } else {
      console.error(`✗ Failed to create "${eventTitle}" (HTTP ${createResp.status}): ${JSON.stringify(createResp.data).slice(0, 200)}`);
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
}

// ─── Notes Commands ──────────────────────────────────────────────────────────

async function fetchAllNotes(tab, session) {
  // Get zone owner
  const zonesUrl = `${session.ckdbUrl}/database/1/com.apple.notes/production/private/zones/list?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
  const zonesResp = await icloudFetch(tab, zonesUrl, { method: 'POST', body: {} });

  if (!zonesResp.ok || !zonesResp.data || !zonesResp.data.zones) {
    cli.die('Failed to fetch Notes zones', { prefix: '' });
  }

  const notesZone = zonesResp.data.zones.find(z => z.zoneID.zoneName === 'Notes');
  if (!notesZone) {
    cli.die('Notes zone not found', { prefix: '' });
  }

  const owner = notesZone.zoneID.ownerRecordName;

  // Fetch notes via changes/zone (paginate via syncToken)
  let allNotes = [];
  let syncToken = null;
  let moreComing = true;
  let iterations = 0;
  const maxIterations = 10;

  while (moreComing && iterations < maxIterations) {
    const changesUrl = `${session.ckdbUrl}/database/1/com.apple.notes/production/private/changes/zone?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
    const body = {
      zones: [{ zoneID: { zoneName: 'Notes', ownerRecordName: owner } }]
    };
    if (syncToken) {
      body.zones[0].syncToken = syncToken;
    }

    const changesResp = await icloudFetch(tab, changesUrl, { method: 'POST', body });

    if (!changesResp.ok || !changesResp.data || !changesResp.data.zones || !changesResp.data.zones[0]) {
      break;
    }

    const zone = changesResp.data.zones[0];
    const records = zone.records || [];
    const notes = records.filter(r => r.recordType === 'Note');
    allNotes.push(...notes);

    syncToken = zone.syncToken;
    moreComing = !!zone.moreComing;
    iterations++;
  }

  return allNotes;
}

async function decodeNotesInPage(tab, notes) {
  const noteData = notes.map(n => ({
    id: n.recordName,
    titleB64: n.fields.TitleEncrypted ? n.fields.TitleEncrypted.value : '',
    snippetB64: n.fields.SnippetEncrypted ? n.fields.SnippetEncrypted.value : '',
    modified: n.fields.ModificationDate ? n.fields.ModificationDate.value : 0,
    created: n.fields.CreationDate ? n.fields.CreationDate.value : 0,
    deleted: n.fields.Deleted ? n.fields.Deleted.value : 0
  }));

  // Process in batches to avoid eval payload limits
  const batchSize = 50;
  let allDecoded = [];

  for (let start = 0; start < noteData.length; start += batchSize) {
    const batch = noteData.slice(start, start + batchSize);
    // See the note above icloudFetch()'s fnSource: must be an invoked IIFE,
    // not a bare function expression, or evalAsync silently returns "{}".
    const fnSource = `(async () => {
      const notes = ${JSON.stringify(batch)};
      function decodeB64(b64) {
        if (!b64) return "";
        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder("utf-8").decode(bytes);
        } catch(e) { return ""; }
      }
      return notes
        .filter(n => n.deleted === 0)
        .map(n => ({
          id: n.id,
          title: decodeB64(n.titleB64),
          snippet: decodeB64(n.snippetB64),
          modified: n.modified,
          created: n.created
        }));
    })()`;

    let parsed;
    try {
      parsed = await browser.evalAsync(tab, fnSource);
    } catch (e) {
      console.error('Failed to decode notes batch: ' + e.message);
      continue;
    }
    allDecoded.push(...parsed);
  }

  // Sort by modification date descending
  allDecoded.sort((a, b) => b.modified - a.modified);
  return allDecoded;
}

async function readNoteContent(tab, noteId, allNotes) {
  const note = allNotes.find(n => n.recordName === noteId);
  if (!note) {
    cli.die(`Note not found: ${noteId}`, { prefix: '' });
  }

  const textDataB64 = note.fields.TextDataEncrypted ? note.fields.TextDataEncrypted.value : '';
  const titleB64 = note.fields.TitleEncrypted ? note.fields.TitleEncrypted.value : '';

  if (!textDataB64) {
    // See the note above icloudFetch()'s fnSource: must be an invoked IIFE.
    const fnSource = `(async () => {
      function decodeB64(b64) {
        if (!b64) return "";
        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder("utf-8").decode(bytes);
        } catch(e) { return ""; }
      }
      return { title: decodeB64(${JSON.stringify(titleB64)}), content: "(empty note)" };
    })()`;
    try {
      return await browser.evalAsync(tab, fnSource);
    } catch (e) {
      return { title: '', content: '(empty note)' };
    }
  }

  // Decompress gzip and extract text in page context.
  // See the note above icloudFetch()'s fnSource: must be an invoked IIFE.
  const fnSource = `(async () => {
    const b64 = ${JSON.stringify(textDataB64)};
    const titleB64 = ${JSON.stringify(titleB64)};

    function decodeB64(b64) {
      if (!b64) return "";
      try {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder("utf-8").decode(bytes);
      } catch(e) { return ""; }
    }

    try {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while(true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((a, c) => a + c.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { result.set(c, offset); offset += c.length; }

      // Extract text from Apple Notes protobuf
      // Strategy: find the longest length-prefixed UTF-8 string (field tag 0x12)
      function extractNoteText(bytes) {
        let bestText = "";
        for (let i = 0; i < bytes.length - 2; i++) {
          if (bytes[i] === 0x12) {
            let len = 0, shift = 0, j = i + 1;
            while (j < bytes.length && (bytes[j] & 0x80)) {
              len |= (bytes[j] & 0x7f) << shift;
              shift += 7; j++;
            }
            if (j < bytes.length) {
              len |= (bytes[j] & 0x7f) << shift; j++;
            }
            if (len > 3 && len < 100000 && j + len <= bytes.length) {
              const slice = bytes.slice(j, j + len);
              try {
                const candidate = new TextDecoder("utf-8", {fatal: true}).decode(slice);
                let printCount = 0;
                for (let c = 0; c < candidate.length; c++) {
                  const code = candidate.charCodeAt(c);
                  if ((code >= 32 && code <= 126) || code === 10 || code === 9 || code >= 160) printCount++;
                }
                const printableRatio = printCount / candidate.length;
                if (printableRatio > 0.7 && candidate.length > bestText.length) {
                  bestText = candidate;
                }
              } catch(e) {}
            }
          }
        }
        return bestText;
      }
      let readable = extractNoteText(result);
      if (!readable) {
        // Fallback: strip non-printable from full decode
        const text = new TextDecoder("utf-8", { fatal: false }).decode(result);
        let cleaned = "";
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code === 10 || code === 9 || (code >= 32 && code <= 126) || code >= 160) {
            cleaned += text[i];
          }
        }
        readable = cleaned.trim();
      }

      return { title: decodeB64(titleB64), content: readable };
    } catch(e) {
      return { error: e.message, title: decodeB64(titleB64) };
    }
  })()`;

  let parsed;
  try {
    parsed = await browser.evalAsync(tab, fnSource);
  } catch (e) {
    cli.die('Failed to read note content: ' + e.message, { prefix: '' });
  }

  return parsed;
}

async function cmdNotes() {
  const { flags, positional: allPositional } = process.argv.parseFlags();
  const positional = allPositional.slice(1);
  const jsonOutput = !!flags.json;
  const searchQuery = flags.search || null;

  // Check for "read" subcommand
  if (positional[0] === 'read') {
    const noteId = positional[1];
    if (!noteId) {
      cli.die('Usage: icloud notes read <note-id>', { prefix: '' });
    }
    await cmdNoteRead(noteId, jsonOutput);
    return;
  }

  const tab = await getICloudTab();
  const session = await getSession(tab);
  const rawNotes = await fetchAllNotes(tab, session);
  const notes = await decodeNotesInPage(tab, rawNotes);

  // Apply search filter
  let filtered = notes;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = notes.filter(n =>
      (n.title && n.title.toLowerCase().includes(q)) ||
      (n.snippet && n.snippet.toLowerCase().includes(q))
    );
  }

  if (jsonOutput) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    if (searchQuery) {
      console.log(`No notes matching "${searchQuery}".`);
    } else {
      console.log('No notes found.');
    }
    return;
  }

  if (searchQuery) {
    console.log(`Notes matching "${searchQuery}":\n`);
  } else {
    console.log('Recent notes:\n');
  }

  console.log(fmt.col('ID', 40) + fmt.col('Modified', 18) + fmt.col('Title', 40) + 'Snippet');
  console.log('-'.repeat(120));

  for (const n of filtered.slice(0, 30)) {
    console.log(
      fmt.col(n.id, 40) +
      fmt.col(fmtTimestamp(n.modified), 18) +
      fmt.col(n.title || '(untitled)', 40) +
      (n.snippet || '').slice(0, 40)
    );
  }

  const shown = Math.min(filtered.length, 30);
  console.log(`\n${shown} of ${filtered.length} note${filtered.length !== 1 ? 's' : ''} shown.`);
  if (filtered.length > 30) {
    console.log('Use --search to narrow results, or --json for full data.');
  }
}

async function cmdNoteRead(noteId, jsonOutput) {
  const tab = await getICloudTab();
  const session = await getSession(tab);
  const rawNotes = await fetchAllNotes(tab, session);

  const result = await readNoteContent(tab, noteId, rawNotes);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.error) {
    console.error(`Error reading note: ${result.error}`);
    if (result.title) console.log(`Title: ${result.title}`);
    process.exit(1);
  }

  if (result.title) {
    console.log(`# ${result.title}\n`);
  }
  console.log(result.content || '(empty)');
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

async function main() {
  switch (subcommand) {
    case 'calendar':
      await cmdCalendar();
      break;
    case 'notes':
      await cmdNotes();
      break;
    default:
      console.error(`Unknown command: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

await main();
