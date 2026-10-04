// intent-arm's pure parts: the run id, the scoop's prompt, and what the
// result may print. Kept out of the .jsh so tst can test them.

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
function prompt(url, goal, tool) {
  const how =
    tool === 'intent'
      ? 'You browse only through the `intent` command: one call per step, each stating one intent in words, for example `intent --intent "click the Search button"`. Run `intent --help` once for the details.'
      : 'You browse only through the `playwright-cli` command. Run `playwright-cli --help` once for the details.';
  if (url) return `Open ${url} in a new browser tab and do this there: ${goal}\nLeave the final page open in that tab when you are done.\n${how}`;
  const open = tool === 'intent' ? '`intent --intent "open https://…"`' : '`playwright-cli open https://…`';
  return `Do this in the browser: ${goal}\nNo page is open yet: start by opening the site the task needs with ${open}. Leave the final page open in that tab when you are done.\n${how}`;
}

// What a result may carry onto stdout with --private: the run id and counts.
// The answer, the final URL and anything else drawn from the task or the
// pages stay in the run's result.json on the leader, for the bench to read
// into its encrypted trace.
const PRIVATE_FIELDS = ['run', 'tool', 'model', 'ok', 'seconds', 'timedOut', 'exitCode', 'steps', 'stepsFromLog', 'invocations', 'refCalls', 'fullCalls', 'toolCalls', 'turns', 'usage', 'resultChars', 'inputTokensPerTurn', 'intent', 'system1'];

/** The result as printed: in full, or with --private only PRIVATE_FIELDS. */
function printable(result, { private: priv = false } = {}) {
  if (!priv) return result;
  const out = {};
  for (const key of PRIVATE_FIELDS) if (result[key] !== undefined) out[key] = result[key];
  if (result.error !== undefined) out.error = 'see result.json in the run directory';
  return out;
}

module.exports = { hostSlug, runId, checkUrl, prompt, printable, PRIVATE_FIELDS };
