/**
 * icloud.jsh — iCloud CLI for SLICC
 *
 * Access iCloud Calendar and Notes via the iCloud web APIs.
 * Requires an open, authenticated iCloud tab at icloud.com.
 *
 * Usage:
 *   icloud calendar [--date 2d|7d|14d|30d] [--json]
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
  console.log(`icloud — iCloud Calendar, Notes & Reminders CLI for SLICC

Usage:
  icloud calendar [--date 2d|7d|14d|30d] [--json]
  icloud notes [--search "query"] [--json]
  icloud notes read <note-id> [--json]
  icloud reminders [--list "name"] [--completed] [--json]
  icloud monday [--limit N] [--date Nd]
  icloud --help

Calendar:
  Lists upcoming events. Default range is 7 days.
  --date    Range: 1d, 2d, 7d, 14d, 30d (default: 7d)
  --json    Output raw JSON

Notes:
  Lists recent notes (title + snippet).
  --search  Filter notes by title/snippet text
  --json    Output raw JSON

  icloud notes read <note-id>
    Reads the full content of a note by its ID.

Reminders:
  Lists incomplete reminders across all lists.
  --list      Filter to a specific list by name
  --completed Show completed reminders instead
  --json      Output raw JSON

Monday:
  Output items in monday aggregator protocol format.
  --limit N   Max items (default: 50)
  --date Nd   How far ahead for calendar (default: 7d)`);
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
          remindersUrl: data.webservices && data.webservices.reminders ? data.webservices.reminders.url : null,
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
  const { flags } = parseFlags(args.slice(1));
  const jsonOutput = !!flags.json;

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

  if (jsonOutput) {
    console.log(JSON.stringify(events, null, 2));
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

// ─── Reminders Command ───────────────────────────────────────────────────────

async function cmdReminders() {
  const { flags } = parseFlags(args.slice(1));
  const tabId = await getICloudTab();
  const session = await getSession(tabId);
  const showCompleted = flags.completed === true || flags.completed === 'true';
  const filterList = flags.list || null;

  const remBase = session.remindersUrl || session.calendarUrl.replace('calendarws', 'remindersws');
  const endpoint = showCompleted ? 'completed' : 'startup';
  const url = `${remBase}/rd/${endpoint}?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}&lang=en-us&usertz=Europe/Berlin`;

  const resp = await icloudFetch(tabId, url);

  if (!resp.ok) {
    console.error('Reminders API error: ' + JSON.stringify(resp));
    process.exit(1);
  }

  const data = resp.data || {};
  const collections = data.Collections || [];
  const reminders = data.Reminders || [];

  // Build collection lookup
  const colMap = {};
  for (const c of collections) {
    colMap[c.guid] = c.title || 'Untitled';
  }

  // Filter by list name if specified
  let filtered = reminders;
  if (filterList) {
    const lower = filterList.toLowerCase();
    const matchGuids = collections
      .filter(c => (c.title || '').toLowerCase().includes(lower))
      .map(c => c.guid);
    filtered = reminders.filter(r => matchGuids.includes(r.pGuid));
  }

  if (flags.json === true || flags.json === 'true') {
    const output = filtered.map(r => ({
      id: r.guid,
      title: r.title || '',
      list: colMap[r.pGuid] || r.pGuid,
      dueDate: r.dueDate ? `${r.dueDate[1]}-${String(r.dueDate[2]).padStart(2,'0')}-${String(r.dueDate[3]).padStart(2,'0')}` : null,
      completed: !!r.completedDate,
      description: r.description || '',
      priority: r.priority || 0
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log(showCompleted ? 'No completed reminders.' : 'No open reminders.');
    return;
  }

  // Print collections summary
  if (!filterList && collections.length > 0) {
    console.log('Lists: ' + collections.map(c => c.title).join(', '));
    console.log('');
  }

  console.log(`${showCompleted ? 'Completed' : 'Open'} reminders: ${filtered.length}\n`);
  console.log(col('List', 20) + col('Title', 45) + 'Due');
  console.log('-'.repeat(80));

  for (const r of filtered) {
    const list = (colMap[r.pGuid] || '').replace(/ ⚠️/g, '');
    const title = r.title || '(untitled)';
    let due = '';
    if (r.dueDate) {
      due = `${r.dueDate[1]}-${String(r.dueDate[2]).padStart(2,'0')}-${String(r.dueDate[3]).padStart(2,'0')}`;
    }
    console.log(col(list, 20) + col(title, 45) + due);
  }
}

// ─── Monday Protocol Command ─────────────────────────────────────────────────

async function cmdMonday() {
  const { flags } = parseFlags(args.slice(1));
  const tabId = await getICloudTab();
  const session = await getSession(tabId);
  const limit = parseInt(flags.limit || '50', 10);
  const dateRange = flags.date || '7d';

  const items = [];

  // 1. Get calendar events
  const days = parseInt(dateRange) || 7;
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  const calUrl = `${session.calendarUrl}/ca/events?startDate=${start}&endDate=${end}&lang=en-us&usertz=Europe%2FBerlin&clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}`;

  try {
    const calResp = await icloudFetch(tabId, calUrl);
    const calData = calResp.data || {};
    const events = calData.Event || calData.Events || calData.events || [];
    for (const ev of events) {
      const startDt = ev.startDate ? `${ev.startDate[1]}-${String(ev.startDate[2]).padStart(2,'0')}-${String(ev.startDate[3]).padStart(2,'0')}T${String(ev.startDate[4]||0).padStart(2,'0')}:${String(ev.startDate[5]||0).padStart(2,'0')}:00Z` : '';
      items.push({
        id: 'icloud-cal-' + (ev.guid || ev.pGuid || Math.random().toString(36).slice(2)),
        source: 'icloud',
        type: 'calendar',
        title: ev.title || '(no title)',
        subtitle: ev.location || '',
        url: 'https://www.icloud.com/calendar',
        ts: startDt,
        body: ev.description || '',
        participants: [],
        meta: { allDay: !!ev.allDay, location: ev.location || '' }
      });
    }
  } catch (e) {
    // Calendar fetch failed, continue with reminders
  }

  // 2. Get reminders
  const remBase = session.remindersUrl || session.calendarUrl.replace('calendarws', 'remindersws');
  const remUrl = `${remBase}/rd/startup?clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21&clientId=slicc-icloud-skill&dsid=${session.dsid}&lang=en-us&usertz=Europe/Berlin`;

  try {
    const remResp = await icloudFetch(tabId, remUrl);
    const remData = remResp.data || {};
    const reminders = remData.Reminders || [];
    const collections = remData.Collections || [];
    const colMap = {};
    for (const c of collections) colMap[c.guid] = c.title || '';

    for (const r of reminders) {
      items.push({
        id: 'icloud-rem-' + r.guid,
        source: 'icloud',
        type: 'reminder',
        title: r.title || '(untitled)',
        subtitle: (colMap[r.pGuid] || '').replace(/ ⚠️/g, ''),
        url: 'https://www.icloud.com/reminders',
        ts: r.dueDate ? `${r.dueDate[1]}-${String(r.dueDate[2]).padStart(2,'0')}-${String(r.dueDate[3]).padStart(2,'0')}T00:00:00Z` : new Date(r.createdDateExtended * 1000 + Date.UTC(2001, 0, 1)).toISOString(),
        body: r.description || '',
        participants: [],
        meta: { list: (colMap[r.pGuid] || '').replace(/ ⚠️/g, ''), priority: r.priority || 0 }
      });
    }
  } catch (e) {
    // Reminders fetch failed, continue
  }

  // Sort by ts descending and limit
  items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  console.log(JSON.stringify(items.slice(0, limit), null, 2));
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function col(str, width) {
  if (str == null) str = '';
  str = String(str);
  if (str.length > width - 1) return str.slice(0, width - 2) + '… ';
  return str.padEnd(width);
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
    case 'reminders':
      await cmdReminders();
      break;
    case 'monday':
      await cmdMonday();
      break;
    default:
      console.error(`Unknown command: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

await main();
