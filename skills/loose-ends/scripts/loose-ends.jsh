// ─────────────────────────────────────────────────────────────────────────
//  loose-ends — sprinkle-side bootstrap / reseed helper
//
//  Run this from the OWNING SCOOP (the scoop named after the sprinkle). It is
//  the one process allowed to touch `sprinkle`. The store JSON is authoritative
//  and cone-owned; this helper only READS it — it never writes tasks.
//
//  Commands:
//    loose-ends bootstrap   Copy the template into the sprinkle dir, refresh the
//                           VFS, open the panel, then reseed it from the store.
//    loose-ends reseed      Re-send `load-items` from the store to an
//                           already-open panel (no template copy / open).
//
//  Options (all optional, --long form only — single-dash flags are ignored):
//    --name <n>       sprinkle + scoop name           (default: loose-ends)
//    --store <path>   store JSON path                 (default: /shared/loose-ends.json)
//    --template <p>   template .shtml to install      (default: the skill's templates/loose-ends.shtml)
// ─────────────────────────────────────────────────────────────────────────

const exec = require('sliccy:exec');
const fs = require('fs');

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
  const storePath = typeof args.store === 'string' ? args.store : '/shared/loose-ends.json';
  const template = typeof args.template === 'string'
    ? args.template
    : '/workspace/skills/loose-ends/templates/loose-ends.shtml';

  if (cmd === 'reseed') {
    const n = await reseed(name, storePath);
    process.stdout.write(`loose-ends: reseeded '${name}' with ${n} task(s) from ${storePath}\n`);
    return;
  }

  if (cmd === 'bootstrap') {
    if (!fs.existsSync(template)) {
      throw new Error(`template not found: ${template} (pass --template <path>)`);
    }
    const dir = `/shared/sprinkles/${name}`;
    await sh(`mkdir -p ${shellQuote(dir)}`);
    await sh(`cp ${shellQuote(template)} ${shellQuote(`${dir}/${name}.shtml`)}`);
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
    const RATING_HINT =
      'This is a user-curated loose end — a follow-up the user explicitly saved to act on later, ' +
      'so it carries real intent; treat it as actionable unless its summary says it is waiting on ' +
      'someone else. `body` is the human summary; `detail` is the full agent brief. `skills` lists ' +
      'the SLICC skills involved. There is no external state, so do not down-rank it as resolved.';
    const items = store.tasks.slice(0, limit).map((t) => ({
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
    `usage: loose-ends [bootstrap|reseed|monday] [--name <n>] [--store <path>] [--template <path>] [--limit N]\n`
  );
  process.exit(1);
}

await main().catch((e) => {
  process.stderr.write(`loose-ends: ${e.message}\n`);
  process.exit(1);
});
