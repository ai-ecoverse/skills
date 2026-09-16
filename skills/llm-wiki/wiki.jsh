// wiki.jsh — CLI for the LLM wiki knowledge base
// Default wiki root: /mnt/kb. Override via --root, WIKI_ROOT, or the config file.
const fs = require('fs');
const DEFAULT_WIKI_ROOT = '/mnt/kb';
let WIKI_ROOT = DEFAULT_WIKI_ROOT;
let RAW_DIR = WIKI_ROOT + '/_raw';
let ROOT_SOURCE = 'built-in default';
const nk = (s) => String(s).normalize('NFC');

let CATS = null; // populated once by discoverCats()

async function discoverCats(soft) {
  if (CATS) return CATS;
  const root = [], nested = [];
  try {
    const top = await fs.readDir(WIKI_ROOT);
    for (const e of top) {
      const n = en(e);
      if (!n || n.startsWith('_') || n.startsWith('.')) continue;
      const dp = WIKI_ROOT + '/' + n;
      try {
        const es = await fs.readDir(dp);
        if (es.some(f => { const fn = en(f); return fn && fn.endsWith('.md'); }))
          root.push(n);
        if (n === 'projects') {
          for (const pe of es) {
            const pn = en(pe);
            if (!pn || pn.startsWith('_') || pn.startsWith('.')) continue;
            const pp = dp + '/' + pn;
            try {
              const pes = await fs.readDir(pp);
              if (pes.some(f => { const fn = en(f); return fn && fn.endsWith('.md'); }))
                nested.push('projects/' + pn);
            } catch (_) {}
          }
        }
      } catch (_) {} // not a directory or unreadable
    }
  } catch (e) {
    if (soft) return [];
    console.error('Error discovering categories: ' + e.message);
    process.exit(1);
  }
  root.sort((a, b) => a.localeCompare(b));
  nested.sort((a, b) => a.localeCompare(b));
  CATS = root.concat(nested);
  return CATS;
}

function takeRootFlag(argv) {
  const out = [];
  let rootFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (i + 1 >= argv.length) {
        console.error('Error: --root requires a path');
        process.exit(1);
      }
      rootFlag = argv[i + 1];
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return { args: out, rootFlag: rootFlag };
}

const taken = takeRootFlag(process.argv.slice(2));
const args = taken.args;
const rootFlag = taken.rootFlag;
const sub = (args[0] || '').toLowerCase();

function en(e) {
  return typeof e === 'string' ? e : e.name;
}

function configFilePath() {
  const override = process.env.WIKI_CONFIG;
  if (override) return override;
  // Config MUST live outside the skill directory: `upskill update` overwrites
  // the skill tree, which would destroy config stored there.
  const home = process.env.HOME;
  if (home) return home + '/.config/wiki/config.json';
  return '/tmp/wiki-config.json';
}

function parentDir(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return s.slice(0, i);
}

function rootLine() {
  return 'Wiki root:  ' + WIKI_ROOT + ' (' + ROOT_SOURCE + ')';
}

async function readConfigObject() {
  const p = configFilePath();
  try {
    if (!(await fs.exists(p))) return {};
    const raw = await fs.readFile(p);
    const text = String(raw || '');
    if (!text.trim()) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Warning: ignoring malformed config file ' + p + ': ' + e.message);
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Warning: ignoring malformed config file ' + p + ': expected a JSON object');
      return {};
    }
    return parsed;
  } catch (e) {
    console.error('Warning: could not read config file ' + p + ': ' + e.message);
    return {};
  }
}

async function writeConfigObject(obj) {
  const p = configFilePath();
  const dir = parentDir(p);
  if (dir && !(await fs.exists(dir))) {
    try {
      await fs.mkdir(dir);
    } catch (e) {
      console.error('Error: cannot create config directory ' + dir + ': ' + e.message);
      process.exit(1);
    }
  }
  try {
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
  } catch (e) {
    console.error('Error: cannot write config file ' + p + ': ' + e.message);
    process.exit(1);
  }
}

async function resolveRoot(flag) {
  if (flag) {
    WIKI_ROOT = flag;
    RAW_DIR = WIKI_ROOT + '/_raw';
    ROOT_SOURCE = '--root flag';
    return;
  }
  const envRoot = process.env.WIKI_ROOT;
  if (envRoot) {
    WIKI_ROOT = envRoot;
    RAW_DIR = WIKI_ROOT + '/_raw';
    ROOT_SOURCE = 'WIKI_ROOT env';
    return;
  }
  const cfg = await readConfigObject();
  if (cfg && typeof cfg.root === 'string' && cfg.root) {
    WIKI_ROOT = cfg.root;
    RAW_DIR = WIKI_ROOT + '/_raw';
    ROOT_SOURCE = 'from config ' + configFilePath();
    return;
  }
  WIKI_ROOT = DEFAULT_WIKI_ROOT;
  RAW_DIR = WIKI_ROOT + '/_raw';
  ROOT_SOURCE = 'built-in default';
}

async function countCategoryMd(root) {
  let n = 0;
  try {
    const top = await fs.readDir(root);
    for (const e of top) {
      const name = en(e);
      if (!name || name.startsWith('_') || name.startsWith('.')) continue;
      const dp = root + '/' + name;
      try {
        const es = await fs.readDir(dp);
        for (const f of es) {
          const fn = en(f);
          if (fn && fn.endsWith('.md')) n++;
        }
        if (name === 'projects') {
          for (const pe of es) {
            const pn = en(pe);
            if (!pn || pn.startsWith('_') || pn.startsWith('.')) continue;
            try {
              const pes = await fs.readDir(dp + '/' + pn);
              for (const f of pes) {
                const fn = en(f);
                if (fn && fn.endsWith('.md')) n++;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return n;
}

async function notFound(name) {
  console.error('Page not found: ' + name);
  let n = 0;
  try {
    const cats = await discoverCats(true);
    const pages = await catDirs(cats);
    n = pages.length;
  } catch (_) {}
  if (!n) {
    console.error('The wiki root ' + WIKI_ROOT + ' (' + ROOT_SOURCE + ') contains zero pages. You may be pointed at an empty or wrong tree.');
  }
  process.exit(1);
}

async function catDirs(cs) {
  const r = [];
  for (const c of cs) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + c);
      for (const e of es) {
        const n = en(e);
        if (n && n.endsWith('.md')) r.push({ cat: c, file: n, path: WIKI_ROOT + '/' + c + '/' + n });
      }
    } catch (_) {}
  }
  return r;
}

function t(f) {
  return f.replace(/\.md$/, '').replace(/-/g, ' ');
}

async function find(name) {
  const cats = await discoverCats();
  let c = null, s = name;
  if (name.includes('/')) {
    const p = name.split('/');
    // Support projects/<name>/page as well as cat/page
    if (p[0] === 'projects' && p.length >= 3) {
      c = p[0] + '/' + p[1];
      s = p.slice(2).join('/');
    } else {
      c = p[0];
      s = p.slice(1).join('/');
    }
  }
  s = s.replace(/\.md$/, '');
  const ds = c ? [c] : cats;
  for (const d of ds) {
    const p = WIKI_ROOT + '/' + d + '/' + s + '.md';
    if (await fs.exists(p)) return { cat: d, file: s + '.md', path: p };
  }
  const l = nk(s).toLowerCase();
  for (const d of ds) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + d);
      for (const e of es) {
        const n = en(e);
        if (n && nk(n).replace(/\.md$/, '').toLowerCase() === l) return { cat: d, file: n, path: WIKI_ROOT + '/' + d + '/' + n };
      }
    } catch (_) {}
  }
  return null;
}

function wl(c) {
  const r = /\[\[([^\]]+)\]\]/g, ls = [];
  let m;
  for (m = r.exec(c); m !== null; m = r.exec(c)) {
    const target = m[1].split('|', 1)[0].trim();
    if (target) ls.push(target);
  }
  return ls;
}

async function cmdSearch() {
  const cats = await discoverCats();
  const term = args.slice(1).join(' ');
  if (!term) { console.error('Usage: wiki search <term>'); process.exit(1); }
  const lo = nk(term).toLowerCase(), pages = await catDirs(cats);
  let h = 0;
  for (const p of pages) {
    if (h >= 20) break;
    const nm = nk(p.file).toLowerCase().includes(lo);
    let lm = null;
    try {
      const c = await fs.readFile(p.path);
      for (const line of c.split('\n')) {
        if (nk(line).toLowerCase().includes(lo)) { lm = line.trim(); break; }
      }
    } catch (_) { continue; }
    if (nm || lm) { console.log('  ' + p.cat + '/' + p.file + '  —  ' + (lm || t(p.file))); h++; }
  }
  if (!h) console.log('No results for "' + term + '".');
  else console.log('\n' + h + ' result' + (h === 1 ? '' : 's') + '.');
}

async function cmdList() {
  const cats = await discoverCats();
  let c = null;
  if (args[1]) {
    const want = nk(args[1]).toLowerCase();
    c = cats.find(x => nk(x).toLowerCase() === want) || null;
    if (!c) { console.error('Unknown category: ' + args[1] + '\nCategories: ' + cats.join(', ')); process.exit(1); }
  }
  const pages = await catDirs(c ? [c] : cats);
  if (!pages.length) { console.log(c ? 'No pages in ' + c + '.' : 'No wiki pages found.'); return; }
  let cur = null;
  for (const p of pages) {
    if (p.cat !== cur) { if (cur) console.log(''); console.log(p.cat + '/'); cur = p.cat; }
    console.log('  ' + t(p.file) + '  (' + p.cat + '/' + p.file + ')');
  }
  console.log('\n' + pages.length + ' page' + (pages.length === 1 ? '' : 's') + ' total.');
}

async function cmdRead() {
  const name = args.slice(1).join(' ');
  if (!name) { console.error('Usage: wiki read <note-name>'); process.exit(1); }
  const n = await find(name);
  if (!n) { await notFound(name); }
  try {
    const c = await fs.readFile(n.path);
    console.log('[' + n.cat + '/' + n.file + ']\n');
    console.log(c);
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function cmdStats() {
  const cats = await discoverCats();
  const rows = [];
  let tot = 0;
  for (const c of cats) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + c);
      const md = es.filter(e => { const n = en(e); return n && n.endsWith('.md'); });
      if (md.length) rows.push('  ' + c.padEnd(24) + ' ' + md.length);
      tot += md.length;
    } catch (_) {}
  }
  let rc = 0, ea = null, la = null;
  try {
    const re = await fs.readDir(RAW_DIR);
    const mf = re.map(e => en(e)).filter(n => n && n.endsWith('.md'));
    rc = mf.length;
    const ds = [];
    for (const f of mf) { const m = f.match(/^(\d{4}-\d{2}-\d{2})_/); if (m) ds.push(m[1]); }
    ds.sort();
    if (ds.length) { ea = ds[0]; la = ds[ds.length - 1]; }
  } catch (_) {}
  console.log(rootLine());
  if (tot === 0 && rc === 0) {
    console.error('Error: No wiki pages or raw source files found at ' + WIKI_ROOT + '.');
    process.exit(1);
  }
  console.log('Wiki pages by category:');
  for (const row of rows) console.log(row);
  console.log('  ' + 'total'.padEnd(24) + ' ' + tot);
  console.log('\nRaw source files: ' + rc);
  if (ea && la) console.log('  Date range: ' + ea + ' to ' + la);
  let tl = 0;
  const pages = await catDirs(cats);
  for (const p of pages) { try { tl += wl(await fs.readFile(p.path)).length; } catch (_) {} }
  console.log('\nTotal wikilinks: ' + tl);
}

async function cmdLinks() {
  const cats = await discoverCats();
  const name = args.slice(1).join(' ');
  if (!name) { console.error('Usage: wiki links <note-name>'); process.exit(1); }
  const n = await find(name);
  if (!n) { await notFound(name); }
  let ob = [];
  try { ob = [...new Set(wl(await fs.readFile(n.path)))]; } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
  console.log('Links for: ' + n.cat + '/' + n.file + '\n');
  console.log('Outbound (' + ob.length + '):');
  if (!ob.length) console.log('  (none)');
  else for (const l of ob.sort()) console.log('  -> [[' + l + ']]');
  const nm = nk(n.file).replace(/\.md$/, ''), pages = await catDirs(cats), ib = [];
  for (const p of pages) {
    if (nk(p.path) === nk(n.path)) continue;
    try { if (wl(await fs.readFile(p.path)).some(l => nk(l) === nm)) ib.push(p.cat + '/' + p.file); } catch (_) {}
  }
  console.log('\nInbound (' + ib.length + '):');
  if (!ib.length) console.log('  (none)');
  else for (const r of ib.sort()) console.log('  <- ' + r);
}

async function cmdOrphans() {
  const cats = await discoverCats();
  const pages = await catDirs(cats), linked = new Set();
  let readable = 0;
  for (const p of pages) {
    try {
      const c = await fs.readFile(p.path);
      readable++;
      for (const l of wl(c)) linked.add(nk(l));
    } catch (_) {}
  }
  if (readable === 0) {
    console.error('Error: No wiki pages could be read at ' + WIKI_ROOT + '.');
    process.exit(1);
  }
  const orph = [];
  for (const p of pages) { const s = nk(p.file).replace(/\.md$/, ''); if (!linked.has(s)) orph.push(p.cat + '/' + p.file); }
  if (!orph.length) { console.log('No orphan pages found.'); return; }
  console.log('Orphan pages (' + orph.length + '):\n');
  for (const o of orph) console.log('  ' + o);
}

async function cmdRecent() {
  const n = parseInt(args[1], 10) || 10;
  try {
    const es = await fs.readDir(RAW_DIR);
    const mf = es.map(e => en(e)).filter(n => n && n.endsWith('.md'));
    const d = [];
    for (const f of mf) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_(.+?)_[0-9a-f]+\.md$/);
      if (m) d.push({ date: m[1], title: m[2].replace(/-/g, ' '), file: f });
    }
    d.sort((a, b) => b.date.localeCompare(a.date));
    const s = d.slice(0, n);
    console.log(s.length + ' most recent raw sources:\n');
    for (const e of s) { console.log('  ' + e.date + '  ' + e.title); console.log('             ' + e.file); }
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function cmdLog() {
  const n = parseInt(args[1], 10) || 10;
  const lp = WIKI_ROOT + '/log.md';
  try {
    if (!(await fs.exists(lp))) { console.log('log.md does not exist yet.'); return; }
    const c = await fs.readFile(lp), lines = c.split('\n'), entries = [];
    let cur = null;
    for (const l of lines) {
      if (l.startsWith('## ')) { if (cur) entries.push(cur); cur = { heading: l, body: [] }; }
      else if (cur) cur.body.push(l);
    }
    if (cur) entries.push(cur);
    if (!entries.length) { console.log('No log entries found.'); return; }
    const s = entries.slice(-n);
    console.log('Last ' + s.length + ' log entr' + (s.length === 1 ? 'y' : 'ies') + ':\n');
    for (const e of s) { console.log(e.heading); for (const b of e.body.filter(l => l.trim()).slice(0, 3)) console.log('  ' + b.trim()); console.log(''); }
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function configSetRoot(path) {
  if (!(await fs.exists(path))) {
    console.error('Error: path does not exist: ' + path);
    process.exit(1);
  }
  let st;
  try {
    st = await fs.stat(path);
  } catch (e) {
    console.error('Error: cannot stat ' + path + ': ' + e.message);
    process.exit(1);
  }
  if (!st || !st.isDirectory) {
    console.error('Error: not a directory: ' + path);
    process.exit(1);
  }
  const n = await countCategoryMd(path);
  if (n === 0) {
    console.error('Warning: ' + path + ' exists but contains no .md pages in any category subdirectory (a fresh wiki is legitimate).');
  }
  const cfg = await readConfigObject();
  cfg.root = path;
  await writeConfigObject(cfg);
  console.log('Set root = ' + path);
}

async function configUnsetRoot() {
  const p = configFilePath();
  if (!(await fs.exists(p))) {
    console.log('root is not set (no config file at ' + p + ')');
    return;
  }
  const cfg = await readConfigObject();
  if (!('root' in cfg)) {
    console.log('root is not set in ' + p);
    return;
  }
  delete cfg.root;
  await writeConfigObject(cfg);
  console.log('Unset root in ' + p);
}

async function cmdConfig() {
  const action = (args[1] || 'list').toLowerCase();
  if (action === 'list') {
    console.log(rootLine());
    console.log('Config file: ' + configFilePath());
    return;
  }
  if (action === 'path') {
    console.log(configFilePath());
    return;
  }
  if (action === 'get') {
    const key = args[2];
    if (key !== 'root') {
      console.error('Usage: wiki config get root');
      process.exit(1);
    }
    console.log(WIKI_ROOT);
    return;
  }
  if (action === 'set') {
    const key = args[2];
    const val = args.slice(3).join(' ');
    if (key !== 'root' || !val) {
      console.error('Usage: wiki config set root <path>');
      process.exit(1);
    }
    await configSetRoot(val);
    return;
  }
  if (action === 'unset') {
    const key = args[2];
    if (key !== 'root') {
      console.error('Usage: wiki config unset root');
      process.exit(1);
    }
    await configUnsetRoot();
    return;
  }
  console.error('Unknown config command: ' + action);
  console.error('Usage: wiki config [list|path|get root|set root <path>|unset root]');
  process.exit(1);
}

async function cmdHelp() {
  const cats = await discoverCats(true);
  const catLine = cats.length ? cats.join(', ') : '(none discovered at ' + WIKI_ROOT + ')';
  console.log('wiki — LLM wiki knowledge base CLI\n\nUsage: wiki [--root <path>] <command> [args]\n\nCommands:\n  search <term>      Search wiki pages by title and content (max 20 results)\n  list [category]    List all wiki pages, optionally filtered by category\n  read <note>        Display a wiki page (accepts name, name.md, or category/name)\n  stats              Pages per category, raw file count, date range, wikilink count\n  links <note>       Show inbound and outbound wikilinks for a note\n  orphans            Find pages with zero inbound links\n  recent [n]         Show N most recent raw source files (default 10)\n  log [n]            Show last N log.md entries (default 10)\n  config [list]      Show resolved root, its source, and the config file path\n  config get root    Print the resolved wiki root\n  config set root <path>  Persist wiki root (must exist and be a directory)\n  config unset root  Remove the root key from the config file\n  config path        Print the config file path\n  help               Show this help\n\nCategories: ' + catLine + '\n' + rootLine());
}

await resolveRoot(rootFlag);

switch (sub) {
  case 'search': await cmdSearch(); break;
  case 'list': await cmdList(); break;
  case 'read': await cmdRead(); break;
  case 'stats': await cmdStats(); break;
  case 'links': await cmdLinks(); break;
  case 'orphans': await cmdOrphans(); break;
  case 'recent': await cmdRecent(); break;
  case 'log': await cmdLog(); break;
  case 'config': await cmdConfig(); break;
  case 'help': await cmdHelp(); break;
  default: await cmdHelp(); break;
}
