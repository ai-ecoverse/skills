// support-args.js — argv parsing for slack-support and intercom.
//
// Value flags take the --name=value form only; a bare --name is always a boolean and never
// consumes the next word. The runtime's process.argv.parseFlags() reads `--confirm hello`
// as confirm="hello" and drops "hello" from the message, which is wrong for commands whose
// positional arguments are free text. --no-name sets name=false. "--" ends the flags.

function parseArgs(argv) {
  const flags = Object.create(null);
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(a);
    if (m) {
      const [, name, value] = m;
      if (value !== undefined) flags[name] = value;
      else if (name.startsWith('no-')) flags[name.slice(3)] = false;
      else flags[name] = true;
      continue;
    }
    if (a === '-h') {
      flags.h = true;
      continue;
    }
    pos.push(a);
  }
  return { sub: pos[0] || '', pos: pos.slice(1), flags };
}

/** A strict boolean: true, or false for --name=false|0|no|off; anything else is an error. */
function boolFlag(flags, name) {
  const v = flags[name];
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  const lc = String(v).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lc)) return true;
  if (['false', '0', 'no', 'off', ''].includes(lc)) return false;
  throw new Error(`--${name}=${v} is not a boolean; use --${name} or --${name}=false`);
}

module.exports = { parseArgs, boolFlag };
