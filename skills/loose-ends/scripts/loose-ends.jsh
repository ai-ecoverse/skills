// ─────────────────────────────────────────────────────────────────────────
//  loose-ends — store + sprinkle management for the loose-ends panel
//
//  The store JSON (default /shared/loose-ends.json) is authoritative. This
//  command is the single mutation API for it: create/done/snooze/unsnooze do an
//  atomic full rewrite (fs.writeFileSync, no stale-tail risk) AND best-effort
//  sync an open panel via `sprinkle send` (a failed/absent send is non-fatal —
//  the panel self-hydrates from the store on next open, or `reseed` catches up).
//  Prefer these commands over hand-editing the JSON.
//
//  Commands:
//    loose-ends bootstrap   Copy the template into the sprinkle dir, refresh the
//                           VFS, open the panel, then reseed it from the store.
//    loose-ends reseed      Re-send `load-items` from the store to an open panel.
//    loose-ends list        List loose ends (active + snoozed); --snoozed / --json.
//    loose-ends create      Add (or upsert by --id) a loose end. --title required.
//    loose-ends done <id>   Remove a loose end by id.
//    loose-ends snooze <id> <when>   Hide until: tomorrow|monday|week|YYYY-MM-DD (09:00 local).
//    loose-ends unsnooze <id>        Wake a snoozed loose end now.
//    loose-ends monday      Emit the monday-source JSON (snoozed items excluded).
//
//  Options (all optional, --long form only — single-dash flags are ignored):
//    --name <n>       sprinkle + scoop name           (default: loose-ends)
//    --store <path>   store JSON path                 (default: /shared/loose-ends.json)
//    --template <p>   template .shtml to install      (default: the skill's templates/loose-ends.shtml)
// ─────────────────────────────────────────────────────────────────────────

const exec = require('sliccy:exec');
const fs = require('fs');

const DEFAULT_STORE = '/shared/loose-ends.json';

// Hand-parse argv: jsh's parseFlags treats single-dash flags as booleans and
// drops their value, so we only honour explicit --long / --long=value forms.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
        else out[a.slice(2)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function sh(cmd) {
  const r = await exec(cmd);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `command failed: ${cmd}`).trim());
  }
  return (r.stdout || '').trim();
}

function readStore(storePath) {
  if (!fs.existsSync(storePath)) return { updated: null, tasks: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (e) {
    throw new Error(`store at ${storePath} is not valid JSON: ${e.message}`);
  }
  if (!data || !Array.isArray(data.tasks)) return { updated: data && data.updated || null, tasks: [] };
  return data;
}

// Persist the store atomically: write a sibling temp file, then rename it over
// the target. rename(2) is atomic on the same filesystem, so a crash mid-write
// can never leave the authoritative store truncated or half-written — readers
// always see either the old or the complete new content.
function writeStore(storePath, store) {
  store.updated = new Date().toISOString();
  const tmp = storePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, storePath);
  return store;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

// Generate a unique `le-<slug>` id not already present in the store.
function genId(title, tasks) {
  const base = 'le-' + slugify(title);
  let id = base, n = 2;
  const has = (x) => tasks.some((t) => t.id === x);
  while (has(id)) { id = base + '-' + n; n++; }
  return id;
}

// Resolve a snooze "when" token to an ISO timestamp at 09:00 LOCAL.
//   tomorrow | monday (next Monday, strictly future) | week/1w (+7d) | YYYY-MM-DD
//   or any string Date can parse (used verbatim).
function parseWhen(when) {
  const w = String(when || '').trim().toLowerCase();
  const at9 = (d) => { d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const now = new Date();
  if (w === 'tomorrow' || w === 'tom') {
    const d = new Date(now); d.setDate(d.getDate() + 1); return at9(d);
  }
  if (w === 'monday' || w === 'mon') {
    const d = new Date(now);
    let diff = (1 - d.getDay() + 7) % 7; // 0=Sun..6=Sat; Monday=1
    if (diff === 0) diff = 7;            // strictly future
    d.setDate(d.getDate() + diff); return at9(d);
  }
  if (w === 'week' || w === '1w' || w === 'nextweek' || w === 'next-week') {
    const d = new Date(now); d.setDate(d.getDate() + 7); return at9(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
    const [y, m, dd] = w.split('-').map(Number);
    return at9(new Date(y, m - 1, dd));
  }
  const parsed = new Date(when);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`unrecognized snooze time: "${when}" (use: tomorrow | monday | week | YYYY-MM-DD)`);
}

// Best-effort panel sync — the store write is the source of truth; keeping an
// open panel in step is a nicety, so a failed/absent `sprinkle send` is not fatal.
async function trySend(name, payload) {
  try {
    // `exec` resolves with a nonzero exitCode (it does not throw) when the panel
    // is absent/unavailable, so inspect the code — otherwise we'd always report
    // "synced" and suppress the documented "panel not synced" warning.
    const r = await exec(`sprinkle send ${shellQuote(name)} ${shellQuote(JSON.stringify(payload))}`);
    return !!r && r.exitCode === 0;
  } catch (e) { return false; }
}

function isSnoozed(t, now) {
  if (!t || !t.snoozedUntil) return false;
  const ts = new Date(t.snoozedUntil).getTime();
  return !isNaN(ts) && ts > (now == null ? Date.now() : now);
}


async function reseed(name, storePath) {
  const store = readStore(storePath);
  const payload = JSON.stringify({ action: 'load-items', tasks: store.tasks });
  await sh(`sprinkle send ${shellQuote(name)} ${shellQuote(payload)}`);
  return store.tasks.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || 'bootstrap';

  const name = typeof args.name === 'string' ? args.name : 'loose-ends';
  const storePath = typeof args.store === 'string' ? args.store : DEFAULT_STORE;
  const template = typeof args.template === 'string'
    ? args.template
    : '/workspace/skills/loose-ends/templates/loose-ends.shtml';

  if (cmd === 'reseed') {
    const n = await reseed(name, storePath);
    process.stdout.write(`loose-ends: reseeded '${name}' with ${n} task(s) from ${storePath}\n`);
    return;
  }

  if (cmd === 'create' || cmd === 'add') {
    const title = typeof args.title === 'string' ? args.title
      : (args._[1] && !String(args._[1]).startsWith('-') ? args._.slice(1).join(' ') : null);
    if (!title) throw new Error('create: --title <text> is required (or pass the title as positional args)');
    const store = readStore(storePath);
    const id = typeof args.id === 'string' ? args.id : genId(title, store.tasks);
    const skills = typeof args.skills === 'string'
      ? args.skills.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const task = {
      id,
      title,
      summary: typeof args.summary === 'string' ? args.summary : '',
      detail: typeof args.detail === 'string' ? args.detail : '',
      created: new Date().toISOString(),
      skills,
    };
    // Optional primary URL — panel shows a View/Map button that opens it
    // directly via `open` (no cone round-trip). Also accepted as --link.
    if (typeof args.url === 'string' && args.url.trim()) task.url = args.url.trim();
    else if (typeof args.link === 'string' && args.link.trim()) task.url = args.link.trim();
    if (typeof args.snooze === 'string') task.snoozedUntil = parseWhen(args.snooze);
    if (typeof args['session-file'] === 'string' || typeof args['session-id'] === 'string') {
      task.session = {
        id: typeof args['session-id'] === 'string' ? args['session-id'] : '',
        file: typeof args['session-file'] === 'string' ? args['session-file'] : '',
        at: typeof args['session-at'] === 'string' ? args['session-at'] : new Date().toISOString(),
      };
    }
    const existing = store.tasks.findIndex((t) => t.id === id);
    if (existing !== -1) store.tasks[existing] = { ...store.tasks[existing], ...task };
    else store.tasks.push(task);
    writeStore(storePath, store);
    // Send the STORED object (post-merge) so an upsert that omits optional
    // fields doesn't push an unmerged task to the panel — otherwise add-item
    // would replace the panel's copy and drop retained session/snoozedUntil.
    const sent = existing !== -1 ? store.tasks[existing] : task;
    const synced = await trySend(name, { action: 'add-item', task: sent });
    process.stdout.write(`loose-ends: ${existing !== -1 ? 'updated' : 'created'} '${id}'${synced ? '' : ' (panel not synced — reseed or reopen)'}\n`);
    return;
  }

  if (cmd === 'done' || cmd === 'remove' || cmd === 'rm') {
    const id = args._[1];
    if (!id) throw new Error(`${cmd}: an id is required (e.g. loose-ends done le-foo) — see 'loose-ends list'`);
    const store = readStore(storePath);
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    if (store.tasks.length === before) throw new Error(`no loose end with id '${id}' (see 'loose-ends list')`);
    writeStore(storePath, store);
    const synced = await trySend(name, { action: 'remove-item', id });
    process.stdout.write(`loose-ends: removed '${id}'${synced ? '' : ' (panel not synced — reseed or reopen)'}\n`);
    return;
  }

  if (cmd === 'snooze') {
    const id = args._[1];
    const when = typeof args.until === 'string' ? args.until : args._[2];
    if (!id || !when) throw new Error('snooze: usage: loose-ends snooze <id> <tomorrow|monday|week|YYYY-MM-DD>');
    const until = parseWhen(when);
    const store = readStore(storePath);
    const task = store.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no loose end with id '${id}' (see 'loose-ends list')`);
    task.snoozedUntil = until;
    writeStore(storePath, store);
    const synced = await trySend(name, { action: 'add-item', task });
    process.stdout.write(`loose-ends: snoozed '${id}' until ${until}${synced ? '' : ' (panel not synced — reseed or reopen)'}\n`);
    return;
  }

  if (cmd === 'unsnooze' || cmd === 'wake') {
    const id = args._[1];
    if (!id) throw new Error(`${cmd}: an id is required (e.g. loose-ends unsnooze le-foo)`);
    const store = readStore(storePath);
    const task = store.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no loose end with id '${id}' (see 'loose-ends list')`);
    delete task.snoozedUntil;
    writeStore(storePath, store);
    const synced = await trySend(name, { action: 'add-item', task });
    process.stdout.write(`loose-ends: woke '${id}'${synced ? '' : ' (panel not synced — reseed or reopen)'}\n`);
    return;
  }

  if (cmd === 'list' || cmd === 'ls') {
    const store = readStore(storePath);
    const now = Date.now();
    const showSnoozed = args.snoozed === true || args.all === true;
    let rows = store.tasks;
    if (args.snoozed === true) rows = rows.filter((t) => isSnoozed(t, now));
    if (args.json === true) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    if (!rows.length) { process.stdout.write('loose-ends: no loose ends.\n'); return; }
    const active = rows.filter((t) => !isSnoozed(t, now));
    const snoozed = rows.filter((t) => isSnoozed(t, now));
    const line = (t) => {
      const skills = (t.skills && t.skills.length) ? `  [${t.skills.join(', ')}]` : '';
      const snz = isSnoozed(t, now) ? `  (snoozed until ${new Date(t.snoozedUntil).toLocaleString()})` : '';
      return `  ${t.id}\n    ${t.title || ''}${skills}${snz}\n`;
    };
    let out = '';
    active.forEach((t) => { out += line(t); });
    if (snoozed.length) {
      out += `  — snoozed (${snoozed.length}) —\n`;
      snoozed.forEach((t) => { out += line(t); });
    }
    process.stdout.write(`loose-ends (${active.length} active${snoozed.length ? `, ${snoozed.length} snoozed` : ''}):\n` + out);
    return;
  }


  if (cmd === 'bootstrap') {
    if (!fs.existsSync(template)) {
      throw new Error(`template not found: ${template} (pass --template <path>)`);
    }
    const dir = `/shared/sprinkles/${name}`;
    const dest = `${dir}/${name}.shtml`;
    await sh(`mkdir -p ${shellQuote(dir)}`);
    await sh(`cp ${shellQuote(template)} ${shellQuote(dest)}`);
    // Bake the selected --store into the installed template so the panel's own
    // self-hydration (STORE_PATH) reads the SAME store as `reseed`. Without this,
    // a custom --store only affects reseed and the panel reloads the default
    // store on every close/reopen.
    if (storePath !== DEFAULT_STORE) {
      const shtml = fs.readFileSync(dest, 'utf8');
      const safe = storePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const patched = shtml.replace(/const STORE_PATH = '[^']*';/, `const STORE_PATH = '${safe}';`);
      if (patched !== shtml) {
        fs.writeFileSync(dest, patched);
      } else {
        process.stderr.write('loose-ends: warning — could not find STORE_PATH in template to inject --store; panel will hydrate from the template default\n');
      }
    }
    await sh(`sprinkle refresh`);
    await sh(`sprinkle open ${shellQuote(name)}`);
    const n = await reseed(name, storePath);
    process.stdout.write(
      `loose-ends: opened '${name}' and loaded ${n} task(s) from ${storePath}\n` +
      `Stay alive for lick events — do NOT finish.\n`
    );
    return;
  }

  if (cmd === 'monday') {
    // monday source protocol: print a JSON array of items to stdout, logs to stderr.
    // Loose ends are standing follow-ups, so --date is intentionally NOT applied
    // (an old open loose end is still open); --limit is honoured.
    const limit = Number(args.limit != null ? args.limit : 50) || 50;
    const store = readStore(storePath);
    // A snoozed loose end (snoozedUntil in the future) is intentionally out of
    // view until it wakes, so it is NOT surfaced to the monday dispatcher.
    // A snooze whose time has already passed auto-resurfaces (treated as active).
    const now = Date.now();
    const openTasks = store.tasks.filter((t) => !isSnoozed(t, now));
    const RATING_HINT =
      'This is a user-curated loose end — a follow-up the user explicitly saved to act on later, ' +
      'so it carries real intent; treat it as actionable unless its summary says it is waiting on ' +
      'someone else. `body` is the human summary; `detail` is the full agent brief. `skills` lists ' +
      'the SLICC skills involved. There is no external state, so do not down-rank it as resolved.';
    const items = openTasks.slice(0, limit).map((t) => ({
      id: t.id,
      ts: t.created || (t.session && t.session.at) || null,
      source: 'loose-ends',
      title: t.title || t.id,
      body: t.summary || t.detail || '',
      detail: t.detail || t.context || '',
      skills: Array.isArray(t.skills) ? t.skills : [],
      session: t.session || null,
      rating_hint: RATING_HINT,
    }));
    process.stderr.write(`[loose-ends] monday: ${items.length} item(s)\n`);
    process.stdout.write(JSON.stringify(items) + '\n');
    return;
  }

  process.stderr.write(
    `loose-ends: unknown command '${cmd}'\n` +
    `usage:\n` +
    `  loose-ends bootstrap [--name <n>] [--store <path>] [--template <path>]\n` +
    `  loose-ends reseed    [--name <n>] [--store <path>]\n` +
    `  loose-ends list      [--snoozed] [--json]\n` +
    `  loose-ends create --title <t> [--summary <s>] [--detail <d>] [--url <href>] [--skills a,b] [--id <id>] [--snooze <when>]\n` +
    `  loose-ends done <id>\n` +
    `  loose-ends snooze <id> <tomorrow|monday|week|YYYY-MM-DD>\n` +
    `  loose-ends unsnooze <id>\n` +
    `  loose-ends monday    [--limit N]\n`
  );
  process.exit(1);
}

await main().catch((e) => {
  process.stderr.write(`loose-ends: ${e.message}\n`);
  process.exit(1);
});
