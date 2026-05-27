/**
 * icloud.jsh — iCloud CLI for SLICC
 *
 * Access iCloud Calendar and Notes via the iCloud web APIs.
 * Requires an open, authenticated iCloud tab at icloud.com.
 *
 * Usage:
 *   icloud calendar [--date 2d|7d|14d|30d] [--json]
 *   icloud calendar create --title "..." --start "..." --end "..." [--location "..."]
 *   icloud calendar create --from-json   # reads shared-schema JSON from stdin
 *   icloud notes [--search "query"] [--json]
 *   icloud notes read <note-id> [--json]
 *   icloud --help
 */

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printUsage();
  process.exit(0);
}

const subcommand = args[0];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFlags(argsSlice) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argsSlice.length) {
    const arg = argsSlice[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < argsSlice.length && !argsSlice[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argsSlice[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { flags, positional };
}

function printUsage() {
  console.log(`icloud — iCloud Calendar & Notes CLI for SLICC

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
    Reads the full content of a note by its ID.`);
}

function col(str, width) {
  if (str == null) str = '';
  str = String(str);
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
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
  const listResult = await exec('playwright-cli tab-list');
  if (listResult.exitCode !== 0) {
    console.error('Error listing tabs: ' + listResult.stderr);
    process.exit(1);
  }

  const lines = listResult.stdout.trim().split('\n');
  for (const line of lines) {
    if (line.includes('icloud.com')) {
      const match = line.match(/^\[([^\]]+)\]/);
      if (match) return match[1];
    }
  }

  console.error('No iCloud tab found. Please open https://www.icloud.com/ and sign in.');
  process.exit(1);
}

// ─── iCloud Session Discovery ────────────────────────────────────────────────

async function getSession(tabId) {
  const jsCode = `
    (async () => {
      try {
        const resp = await fetch("https://setup.icloud.com/setup/ws/1/validate?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "text/plain", "Origin": "https://www.icloud.com" }
        });
        if (!resp.ok) return JSON.stringify({ error: "VALIDATE_FAILED", status: resp.status });
        const data = await resp.json();
        return JSON.stringify({
          dsid: data.dsInfo ? data.dsInfo.dsid : null,
          calendarUrl: data.webservices && data.webservices.calendar ? data.webservices.calendar.url : null,
          ckdbUrl: data.webservices && data.webservices.ckdatabasews ? data.webservices.ckdatabasews.url : null
        });
      } catch(e) {
        return JSON.stringify({ error: "SESSION_ERROR", message: e.message });
      }
    })()
  `.trim();

  const escapedJs = jsCode.replace(/'/g, "'\\''");
  const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
  if (result.exitCode !== 0) {
    console.error('Failed to get iCloud session: ' + (result.stderr || result.stdout));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch(e) {
    try {
      parsed = JSON.parse(JSON.parse(result.stdout.trim()));
    } catch(e2) {
      console.error('Failed to parse session response: ' + result.stdout.slice(0, 300));
      process.exit(1);
    }
  }

  if (parsed.error) {
    console.error(`iCloud session error: ${parsed.error} — ${parsed.message || ''}`);
    console.error('Please ensure you are signed in at https://www.icloud.com/');
    process.exit(1);
  }

  return parsed;
}

// ─── Generic Page-Context Fetch ──────────────────────────────────────────────

async function icloudFetch(tabId, url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : null;

  let jsCode = `
    (async () => {
      try {
        const resp = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          credentials: "include",
          headers: { "Content-Type": "text/plain", "Origin": "https://www.icloud.com" }${body ? `,\n          body: ${JSON.stringify(body)}` : ''}
        });
        const status = resp.status;
        if (status === 204) return JSON.stringify({ status: 204, ok: true, data: null });
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch(e) { data = text; }
        return JSON.stringify({ status, ok: resp.ok, data });
      } catch(e) {
        return JSON.stringify({ error: "FETCH_ERROR", message: e.message });
      }
    })()
  `.trim();

  const escapedJs = jsCode.replace(/'/g, "'\\''");
  const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
  if (result.exitCode !== 0) {
    console.error('eval failed: ' + (result.stderr || result.stdout));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch(e) {
    try {
      parsed = JSON.parse(JSON.parse(result.stdout.trim()));
    } catch(e2) {
      console.error('Failed to parse API response: ' + result.stdout.slice(0, 500));
      process.exit(1);
    }
  }

  if (parsed.error === 'FETCH_ERROR') {
    console.error('Fetch error: ' + parsed.message);
    process.exit(1);
  }
  if (parsed.status === 401 || parsed.status === 403) {
    console.error(`Authentication error (HTTP ${parsed.status}). Your iCloud session may have expired.`);
    process.exit(1);
  }

  return parsed;
}

// ─── Calendar Commands ───────────────────────────────────────────────────────

async function cmdCalendar() {
  const { flags, positional } = parseFlags(args.slice(1));

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
    console.error('Invalid --date format. Use: 1d, 2d, 7d, 14d, 30d');
    process.exit(1);
  }
  const days = parseInt(rangeMatch[1]);

  const tabId = await getICloudTab();
  const session = await getSession(tabId);

  const now = new Date();
  const startDate = now.toISOString().split('T')[0];
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const endDate = end.toISOString().split('T')[0];

  const url = `${session.calendarUrl}/ca/events?startDate=${startDate}&endDate=${endDate}&lang=en-us&usertz=Europe%2FBerlin&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;

  const resp = await icloudFetch(tabId, url);

  if (!resp.ok) {
    console.error(`Calendar API error (HTTP ${resp.status})`);
    process.exit(1);
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
  console.log(col('Date', 12) + col('Time', 14) + col('Title', 40) + 'Location');
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
      col(displayDate, 12) +
      col(timeStr, 14) +
      col(ev.title || '(no title)', 40) +
      (ev.location || '')
    );
  }

  console.log(`\n${events.length} event${events.length !== 1 ? 's' : ''}.`);
}

// ─── Calendar Create ─────────────────────────────────────────────────────────

async function cmdCalendarCreate(flags, positional) {
  const tabId = await getICloudTab();
  const session = await getSession(tabId);

  // Discover calendars via /ca/allcollections to get GUIDs and ctags
  const calendarName = flags.calendar || null;
  let calendarGuid = null;
  let calendarCtag = null;

  const now = new Date();
  const colStart = now.toISOString().slice(0, 10);
  const colEnd = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const collectionsUrl = `${session.calendarUrl}/ca/allcollections?startDate=${colStart}&endDate=${colEnd}&usertz=Europe%2FBerlin&lang=en-US&clientVersion=6.0&requestID=1&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
  const colResp = await icloudFetch(tabId, collectionsUrl);

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
    console.error('Could not determine target calendar. Ensure iCloud Calendar is accessible.');
    process.exit(1);
  }

  // Determine event source: --from-json or flags
  let events = [];

  if (flags['from-json'] !== undefined) {
    let jsonInput = '';
    if (typeof flags['from-json'] === 'string' && flags['from-json'] !== 'true') {
      try {
        jsonInput = await fs.readFile(flags['from-json']);
      } catch (e) {
        console.error(`icloud calendar create: cannot read file "${flags['from-json']}": ${e.message}`);
        process.exit(1);
      }
    } else {
      // Read from stdin
      try {
        jsonInput = await new Promise((resolve, reject) => {
          let data = '';
          process.stdin.on('data', chunk => { data += chunk; });
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
          setTimeout(() => resolve(data), 5000);
        });
      } catch (e) {
        console.error(`icloud calendar create: failed to read stdin: ${e.message}`);
        process.exit(1);
      }
    }

    if (!jsonInput.trim()) {
      console.error('icloud calendar create: no JSON input received');
      process.exit(1);
    }

    try {
      const parsed = JSON.parse(jsonInput.trim());
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error(`icloud calendar create: invalid JSON: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Single event from flags
    const title = flags.title;
    const start = flags.start;
    const end = flags.end;

    if (!title) { console.error('icloud calendar create: --title is required'); process.exit(1); }
    if (!start) { console.error('icloud calendar create: --start is required'); process.exit(1); }
    if (!end) { console.error('icloud calendar create: --end is required'); process.exit(1); }

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
      const checkResp = await icloudFetch(tabId, checkUrl);
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

    const createResp = await icloudFetch(tabId, createUrl, {
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

async function fetchAllNotes(tabId, session) {
  // Get zone owner
  const zonesUrl = `${session.ckdbUrl}/database/1/com.apple.notes/production/private/zones/list?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;
  const zonesResp = await icloudFetch(tabId, zonesUrl, { method: 'POST', body: {} });

  if (!zonesResp.ok || !zonesResp.data || !zonesResp.data.zones) {
    console.error('Failed to fetch Notes zones');
    process.exit(1);
  }

  const notesZone = zonesResp.data.zones.find(z => z.zoneID.zoneName === 'Notes');
  if (!notesZone) {
    console.error('Notes zone not found');
    process.exit(1);
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

    const changesResp = await icloudFetch(tabId, changesUrl, { method: 'POST', body });

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

async function decodeNotesInPage(tabId, notes) {
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
    const jsCode = `
      (async () => {
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
        const decoded = notes
          .filter(n => n.deleted === 0)
          .map(n => ({
            id: n.id,
            title: decodeB64(n.titleB64),
            snippet: decodeB64(n.snippetB64),
            modified: n.modified,
            created: n.created
          }));
        return JSON.stringify(decoded);
      })()
    `.trim();

    const escapedJs = jsCode.replace(/'/g, "'\\''");
    const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
    if (result.exitCode !== 0) {
      console.error('Failed to decode notes batch: ' + (result.stderr || result.stdout));
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch(e) {
      try {
        parsed = JSON.parse(JSON.parse(result.stdout.trim()));
      } catch(e2) {
        continue;
      }
    }
    allDecoded.push(...parsed);
  }

  // Sort by modification date descending
  allDecoded.sort((a, b) => b.modified - a.modified);
  return allDecoded;
}

async function readNoteContent(tabId, noteId, allNotes) {
  const note = allNotes.find(n => n.recordName === noteId);
  if (!note) {
    console.error(`Note not found: ${noteId}`);
    process.exit(1);
  }

  const textDataB64 = note.fields.TextDataEncrypted ? note.fields.TextDataEncrypted.value : '';
  const titleB64 = note.fields.TitleEncrypted ? note.fields.TitleEncrypted.value : '';

  if (!textDataB64) {
    const jsCode = `
      (async () => {
        function decodeB64(b64) {
          if (!b64) return "";
          try {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new TextDecoder("utf-8").decode(bytes);
          } catch(e) { return ""; }
        }
        return JSON.stringify({ title: decodeB64(${JSON.stringify(titleB64)}), content: "(empty note)" });
      })()
    `.trim();
    const escapedJs = jsCode.replace(/'/g, "'\\''");
    const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch(e) { try { parsed = JSON.parse(JSON.parse(result.stdout.trim())); } catch(e2) { return { title: '', content: '(empty note)' }; } }
    return parsed;
  }

  // Decompress gzip and extract text in page context
  const jsCode = `
    (async () => {
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
        
        return JSON.stringify({ title: decodeB64(titleB64), content: readable });
      } catch(e) {
        return JSON.stringify({ error: e.message, title: decodeB64(titleB64) });
      }
    })()
  `.trim();

  const escapedJs = jsCode.replace(/'/g, "'\\''");
  const result = await exec(`playwright-cli eval --tab=${tabId} '${escapedJs}'`);
  if (result.exitCode !== 0) {
    console.error('Failed to read note content: ' + (result.stderr || result.stdout));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch(e) {
    try {
      parsed = JSON.parse(JSON.parse(result.stdout.trim()));
    } catch(e2) {
      console.error('Failed to parse note content');
      process.exit(1);
    }
  }

  return parsed;
}

async function cmdNotes() {
  const { flags, positional } = parseFlags(args.slice(1));
  const jsonOutput = !!flags.json;
  const searchQuery = flags.search || null;

  // Check for "read" subcommand
  if (positional[0] === 'read') {
    const noteId = positional[1];
    if (!noteId) {
      console.error('Usage: icloud notes read <note-id>');
      process.exit(1);
    }
    await cmdNoteRead(noteId, jsonOutput);
    return;
  }

  const tabId = await getICloudTab();
  const session = await getSession(tabId);
  const rawNotes = await fetchAllNotes(tabId, session);
  const notes = await decodeNotesInPage(tabId, rawNotes);

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

  console.log(col('ID', 40) + col('Modified', 18) + col('Title', 40) + 'Snippet');
  console.log('-'.repeat(120));

  for (const n of filtered.slice(0, 30)) {
    console.log(
      col(n.id, 40) +
      col(fmtTimestamp(n.modified), 18) +
      col(n.title || '(untitled)', 40) +
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
  const tabId = await getICloudTab();
  const session = await getSession(tabId);
  const rawNotes = await fetchAllNotes(tabId, session);

  const result = await readNoteContent(tabId, noteId, rawNotes);

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
