// intent-arm's pure parts: the run id, the scoop's prompt, and what the
// result may print. Kept out of the .jsh so tst can test them.

// The commands a scoop gets beside its browser tool, the same for every
// arm. Shell loops and helper scripts that batch tool calls are fair play
// (Lars, 2026-10-03), so bash and sh are in too; whatever they run is still
// held to the scoop's grant. date: eight BU Bench V2.1 runs were refused the
// clock and could not give the observation time a task asked for (2026-10-04).
const UTILITIES = ['grep', 'head', 'tail', 'sleep', 'sed', 'awk', 'cut', 'wc', 'sort', 'uniq', 'echo', 'cat', 'tr', 'jq', 'bash', 'sh', 'date'];

// --toolset full: every command the shell has, as the cone has them,
// except the browser's own commands: in the intent arm playwright-cli is
// reached through intent, each call with its intent stated (Lars,
// 2026-10-04). node with sliccy:browser, open and the like are not blocked
// but counted (audit). The list comes from the shell's `commands`; this
// one stands in when it cannot be read.
const BROWSER_COMMANDS = ['playwright-cli', 'playwright', 'puppeteer'];
const FULL_TOOLS = ['curl', 'python3', 'python', 'node', 'open', 'convert', 'magick', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'find', 'xargs', 'base64', 'git', 'tar', 'unzip', 'zip'];
const TOOLSETS = ['browser', 'full'];
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** The command names in the output of the shell's `commands` (indented, comma-separated lists). */
function commandNames(text) {
  const names = new Set();
  for (const line of String(text).split('\n')) {
    if (!/^\s{3,}\S/.test(line)) continue;
    for (const n of line.split(',')) {
      const name = n.trim();
      if (/^[A-Za-z0-9_][\w.+-]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * The commands a scoop may run beside its tool. browser: the text
 * utilities. full: every command `commands` lists (or FULL_TOOLS), less the
 * browser commands and this driver, with the tool itself in.
 */
function utilitiesFor(toolset = 'browser', listed = []) {
  if (toolset !== 'full') return UTILITIES;
  const all = listed.length >= 20 ? listed : [...UTILITIES, ...FULL_TOOLS];
  return [...new Set([...all, ...UTILITIES])].filter((c) => !BROWSER_COMMANDS.includes(c) && c !== 'intent-arm');
}

// A way around the tool: a script that drives the browser itself.
const BYPASS = /sliccy:browser|(?:require|import)\s*\(\s*['"](?:playwright|puppeteer)[^'"]*['"]|from\s+['"](?:playwright|puppeteer)[^'"]*['"]/;
// A browser command typed bare, at the start of a pipeline segment.
const BARE = /(?:^|[;&|(`{]\s*|\$\(\s*|\b(?:then|do|else)\s+)(?:playwright-cli|playwright|puppeteer)(?=\s|$|[;&|)])/g;

/**
 * What a run did around the rules, from its tool calls ([{ command }]) and
 * the scripts it left ([{ name, text }]): bypass, the calls and files that
 * drive the browser without the tool (bypassFiles: their names); barePlaywright,
 * the browser commands typed bare (refused by the grant).
 */
function audit(calls, files = []) {
  const bypassCalls = calls.filter((c) => BYPASS.test(c.command || '')).length;
  const bypassFiles = files.filter((f) => BYPASS.test(f.text || '')).map((f) => f.name);
  const barePlaywright = calls.reduce((n, c) => n + (String(c.command || '').match(BARE) || []).length, 0);
  // Counts for stdout (--private); the file names, which the scoop chose and
  // may carry task words, only in result.json.
  return { bypass: { calls: bypassCalls, files: bypassFiles.length }, barePlaywright, bypassFiles };
}

/** The page's hostname as a run-id slug: news.ycombinator.com → news-ycombinator-com; no URL → run. */
function hostSlug(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return (
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'run'
  );
}

/**
 * <time>-<hostname slug>, as meep-meep's trace.js names runs: diagnostics can
 * tell this goal's run from the one before it. Without a URL: <time>-run.
 */
const runId = (url, now = new Date()) => `${now.toISOString().replace(/[:.]/g, '-')}-${hostSlug(url)}`;

/** A start URL, if given, must be http(s). → an error message, or null. */
function checkUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `--url is not a URL: ${url.slice(0, 80)}`;
  }
  return /^https?:$/.test(parsed.protocol) ? null : '--url must be http or https';
}

/**
 * The scoop's prompt. With a URL the scoop opens it first. Without one (a
 * bench task that names its site in words, BU Bench V2.1) no page is open:
 * the scoop finds the site and opens it itself, as the bench's own agents do.
 */
function prompt(url, goal, tool, toolset = 'browser') {
  const full = toolset === 'full';
  const how =
    tool === 'intent'
      ? full
        ? 'Use the `intent` command for the browser: one call per step, each stating one intent in words, for example `intent --intent "click the Search button"`; run `intent --help` once for the details. `playwright-cli`, `playwright` and `puppeteer` are not available as such here: their commands go through intent, each with its intent stated: `intent <command> [args] --intent "<what you want and why>"`, for example `intent screenshot --tab=ID --filename=page.png --intent "see the result list"`. `open --view --size medium <file>` shows you an image. Everything else in the shell is yours to use.'
        : 'You browse only through the `intent` command: one call per step, each stating one intent in words, for example `intent --intent "click the Search button"`. Run `intent --help` once for the details.'
      : full
        ? 'Use the `playwright-cli` command for the browser. Run `playwright-cli --help` once for the details. For everything else you may use the shell (curl, python3, convert, …) as you see fit.'
        : 'You browse only through the `playwright-cli` command. Run `playwright-cli --help` once for the details.';
  if (url) return `Open ${url} in a new browser tab and do this there: ${goal}\nLeave the final page open in that tab when you are done.\n${how}`;
  const open = tool === 'intent' ? '`intent --intent "open https://…"`' : '`playwright-cli open https://…`';
  return `Do this in the browser: ${goal}\nNo page is open yet: start by opening the site the task needs with ${open}. Leave the final page open in that tab when you are done.\n${how}`;
}

// What a result may carry onto stdout with --private: the run id and counts.
// The answer, the final URL and anything else drawn from the task or the
// pages stay in the run's result.json on the leader, for the bench to read
// into its encrypted trace.
const PRIVATE_FIELDS = ['run', 'tool', 'model', 'toolset', 'thinking', 'bypass', 'barePlaywright', 'ok', 'seconds', 'timedOut', 'exitCode', 'steps', 'stepsFromLog', 'invocations', 'refCalls', 'fullCalls', 'toolCalls', 'turns', 'usage', 'resultChars', 'inputTokensPerTurn', 'intent', 'system1'];

/** The result as printed: in full, or with --private only PRIVATE_FIELDS. */
function printable(result, { private: priv = false } = {}) {
  if (!priv) return result;
  const out = {};
  for (const key of PRIVATE_FIELDS) if (result[key] !== undefined) out[key] = result[key];
  if (result.error !== undefined) out.error = 'see result.json in the run directory';
  return out;
}

module.exports = { UTILITIES, FULL_TOOLS, BROWSER_COMMANDS, TOOLSETS, THINKING, commandNames, utilitiesFor, audit, hostSlug, runId, checkUrl, prompt, printable, PRIVATE_FIELDS };
