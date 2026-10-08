// argv.js — strict argument parser for domain-hoarding.jsh.
//
// Why not process.argv.parseFlags()? It treats `--json live.zip` as
// `json = "live.zip"` (it cannot know --json is boolean), which silently eats a
// domain. Booleans are therefore declared explicitly. Unknown flags are an error
// rather than ignored: a typo'd `--tld` that quietly scans the default list is
// exactly the "success-shaped wrong answer" this skill exists to avoid.
//
// Free of sliccy:* so the tst suite can import it (CLAUDE.md §16).

const BOOL_FLAGS = new Set([
  'json',
  'csv',
  'all',
  'live-tlds',
  'full',
  'verify',
  'no-rdap',
  'no-dns',
  'no-whois',
  'no-color',
  'no-premium',
  'no-cache',
  'quiet',
  'q',
  'help',
  'h',
  'version',
]);

const VALUE_FLAGS = new Set([
  'tlds',
  'out',
  'concurrency',
  'delay',
  'timeout',
  'from',
  'cache-ttl',
  'budget',
  'whois-max',
]);

/**
 * Parse argv (without node/script) into { positional, flags }.
 * Throws Error on unknown flags or a value flag with no value.
 */
function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = inline === undefined ? true : !/^(false|0|no|off|)$/i.test(inline);
      } else if (VALUE_FLAGS.has(name)) {
        let value = inline;
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || (value.startsWith('--') && value.length > 2)) {
            throw new Error(`--${name} needs a value`);
          }
          i++;
        }
        flags[name] = value;
      } else {
        throw new Error(`unknown flag --${name}`);
      }
    } else if (tok.length > 1 && tok.startsWith('-')) {
      // Any other leading dash is a flag: domains and labels can never start with '-', and
      // silently treating a combined '-qh' as a domain name would be a success-shaped mistake.
      const name = tok.slice(1);
      if (!/^[a-zA-Z]$/.test(name) || !BOOL_FLAGS.has(name)) throw new Error(`unknown flag ${tok}`);
      flags[name] = true;
    } else {
      positional.push(tok);
    }
  }
  if (flags.h) flags.help = true;
  if (flags.q) flags.quiet = true;
  return { positional, flags };
}

/** Split "a, b c,d" into ['a','b','c','d'], dropping empties. */
function parseList(s) {
  return String(s || '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

module.exports = { BOOL_FLAGS, VALUE_FLAGS, parseArgv, parseList };
