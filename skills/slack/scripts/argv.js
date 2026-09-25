// argv.js — argument-parsing utilities shared by slack-ext.jsh.
//
// Deliberately free of `sliccy:*`, `fs`, and `path` so the tst suite can
// import this module in the SLICC test realm (CLAUDE.md §16). Fatal parse
// errors throw a plain Error so the caller can handle them and so the tst
// realm's process.exitCode is not poisoned when throws() catches them.
// In slack-ext.jsh the top-level try/catch passes those errors to cli.die.
//
// Consumed by slack-ext.jsh via `const { BOOL_FLAGS, parseArgv, parseList } = require('./argv.js');`

// Flags that take no value (presence = true). This explicit set is required
// because the generic parser cannot distinguish a boolean flag from a
// value-less flag when the next token looks like a value.
const BOOL_FLAGS = new Set(['confirm', 'json', 'help', 'h', 'allow-deletions', 'allow-shared']);

function parseArgv(argv) {
  const f = Object.create(null);
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let m = /^--([^=]+)=([\s\S]*)$/.exec(a);
    if (m) {
      const bname = m[1];
      const bval = m[2];
      if (BOOL_FLAGS.has(bname)) {
        // FINDING 1 FIX: normalize boolean flags in --name=value form so that
        // --confirm=false stores a real boolean false (not the truthy string).
        // An unrecognised value (typo like --confirm=fasle) is fatal — it must
        // never accidentally authorise a mutation.
        const lc = bval.toLowerCase();
        if (lc === 'true' || lc === '1' || lc === 'yes' || lc === 'on') {
          f[bname] = true;
        } else if (lc === 'false' || lc === '0' || lc === 'no' || lc === 'off' || lc === '') {
          f[bname] = false;
        } else {
          throw new Error(
            '--' + bname + '=' + bval + ' is not a valid boolean value.' +
              ' Use --' + bname + ' (true) or --' + bname + '=false/true/yes/no/on/off/0/1.',
          );
        }
      } else {
        f[bname] = bval;
      }
      continue;
    }
    m = /^--(.+)$/.exec(a);
    if (m) {
      const name = m[1];
      const next = argv[i + 1];
      if (BOOL_FLAGS.has(name) || next === undefined || /^--/.test(next)) {
        f[name] = true;
        continue;
      }
      f[name] = next;
      i += 1;
      continue;
    }
    pos.push(a);
  }
  return { flags: f, positional: pos };
}

function parseList(raw, label) {
  if (raw === undefined) return [];
  if (raw === true) {
    // Valueless flag: throw so the caller (slack-ext.jsh's top-level catch ->
    // cli.die) can report it. Throwing keeps process.exitCode clean in tst.
    throw new Error('--' + label + ' needs a value, e.g. --' + label + '=channels:read');
  }
  const items = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

module.exports = { BOOL_FLAGS, parseArgv, parseList };
