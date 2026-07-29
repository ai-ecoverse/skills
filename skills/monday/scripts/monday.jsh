// monday.jsh — Aggregator/dispatcher for inbox and todo sources
//
// Usage:
//   monday [source1] [source2] ... [--flags]
//
// Examples:
//   monday gh slack --limit 20 --date 3d
//   monday --rate-importance 9-4 --rate-urgency 8-3 --rate-summary 500
//   monday gh --limit 10 --rate-importance 8-3 --rate-model us.anthropic.claude-haiku
//
// With no positional args, auto-discovers monday-compatible commands on PATH.

// Runtime bridge: the jsh runtime no longer injects `exec` as a bare global;
// obtain it explicitly. `exec` is callable directly.
const exec = require('sliccy:exec');
// `fs` is used for the persistent rating cache and the done/ignore list only —
// the rating agents still write nothing (prompts are passed as argv).
const fs = require('fs');

// Single POSIX-shell-quote a value for safe interpolation into an exec()
// command line (exec runs through the jsh shell bridge).
function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// ─── Persistent state (rating cache + done/ignore list) ──────────────────────
// Both live outside the repo, keyed off $MONDAY_HOME or ~/.monday, so a rerun
// doesn't re-pay for unchanged items and dismissed items stay dismissed.
const STATE_DIR =
  process.env.MONDAY_HOME ||
  (process.env.HOME && process.env.HOME !== '/'
    ? `${process.env.HOME}/.monday`
    : '/shared/monday');
const CACHE_FILE = `${STATE_DIR}/rating-cache.json`;
const SUPPRESS_FILE = `${STATE_DIR}/suppress.json`;

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* best effort; writeFile will surface real errors */ }
}
function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJson(path, obj) {
  ensureStateDir();
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

// Stable, dependency-free string hash (djb2/xor) for cache keys.
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2); // argv[0]=node, argv[1]=script path, argv[2+]=actual args

/**
 * Parse CLI arguments into { subcommands, flags }.
 * Handles --flag value, --flag=value, and bare positional args.
 */
function parseArgs(args) {
  const subcommands = [];
  const flags = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      // Handle --flag=value
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
        i++;
      } else {
        // Handle --flag value (next arg is the value, unless it's another flag or missing)
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 2;
        } else {
          // Boolean flag with no value
          flags[key] = 'true';
          i++;
        }
      }
    } else {
      // Positional arg — it's a sub-command name
      subcommands.push(arg);
      i++;
    }
  }

  return { subcommands, flags };
}

const { subcommands, flags } = parseArgs(args);

// ─── Help ────────────────────────────────────────────────────────────────────

if (flags.help || flags.h) {
  console.log(`monday — aggregate and rank inbox items across tools

USAGE
  monday [source...] [flags]
  monday done|ignore|mute <id>...   # never show these items again
  monday restore <id>...            # undo a done/ignore/mute
  monday ignored                    # list what's silenced
  monday cache-clear                # wipe the rating cache

  With no sources, auto-discovers monday-compatible commands on PATH.
  Sources: gh, slack, teams, outlook, gmail, servicenow, linkedin, tiktok

FLAGS
  --limit N              Max items per source (default 50). Enforced by monday
                         even if a source ignores it.
  --depth N              Thread/comment depth per item (default 5)
  --date Nd              Time window, e.g. 3d, 2w (default 7d)

RATING (each rated item costs one model call — start small)
  --rate-importance HI-LO   Rate importance, e.g. 9-1
  --rate-urgency HI-LO      Rate urgency, e.g. 8-1
  --rate-summary N          ~N-character summary per item
  --rate-effort             Estimate effort per item (effort_minutes + a
                            quick/short/deep band). Feeds --sort roi & --budget.
  --rate-model NAME         Model for rating. Accepts an exact id from \`models\`
                            or a unique substring (e.g. "us.anthropic.claude-haiku"). Validated
                            before any call; defaults to the cheapest model.
  --rate-context PATH       Read-only knowledge base the rater may grep
  --rate-concurrency N      Parallel rating agents (default 4)
  --rate-max N              Refuse to rate more than N items (default 60)

RANKING & BACKPRESSURE (turn a wall of items into a plan of attack)
  --sort MODE               roi (impact per minute — best bang-for-buck first;
                            the default when --rate-effort is on), value
                            (importance x urgency), or newest (timestamp)
  --focus N                 Promote only the top N to-dos to the "now" bucket;
                            the rest become "later". A doable slice, not the
                            whole backlog.
  --budget DURATION         Pack the highest-ranked to-dos that fit a time box
                            into "now" (e.g. 90m, 2h, 1h30m); needs
                            --rate-effort. The rest become "later".

  Every rated item is also tagged actionable vs not: informational items
  (merged PRs, closed issues, build/FYI notifications) go to a separate "fyi"
  bucket — awareness only, never counted against your time budget. Items where
  you are the author (still open) or were asked to review/act are kept
  actionable even if the rater guessed FYI (disable with --no-trust-signals).

STATE (persisted under $MONDAY_HOME or ~/.monday)
  --no-cache             Don't reuse or write cached ratings this run
  --include-ignored      Show items on the done/ignore list anyway
  --no-trust-signals     Don't override the rater from source relationship meta

  Ratings are cached (keyed by item content + rating params + model), so a
  rerun only pays for new or changed items. "monday done|ignore <id>" hides an
  item permanently; "monday restore <id>" brings it back.

OUTPUT
  JSON array on stdout; progress, plan summary, and warnings on stderr.
  Sorted by the chosen --sort mode. Rated items carry a "category"
  (fyi/confirm/review/respond/act) and derived "actionable" flag;
  when a plan is active each item carries a "bucket" field
  ("now" | "later" | "fyi") so a presenter can show a doable slice first,
  hold the rest, and keep informational items in a separate awareness list.

EXAMPLES
  monday gh --limit 5 --date 1d
  monday slack teams --limit 10 --date 3d
  monday gh --limit 5 --rate-importance 9-1 --rate-urgency 8-1
  monday gh --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --sort roi
  monday --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --budget 90m`);
  process.exit(0);
}

// ─── Flag Defaults ───────────────────────────────────────────────────────────

const limit = flags['limit'] || '50';
const depth = flags['depth'] || '5';
const date  = flags['date']  || '7d';

// Rating flags (local only — not passed to children)
const rateImportance = flags['rate-importance'] || null;   // e.g. "8-3"
const rateUrgency    = flags['rate-urgency']    || null;   // e.g. "9-2"
const rateSummary    = flags['rate-summary']     || null;   // e.g. "1000"
// Rating model. Resolved against `models --json` in main() before any agent
// spawns — see resolveRateModel(). We deliberately do NOT hardcode a default
// model id here: exact ids carry a version+date suffix that drifts, and the
// bare alias `claude-haiku-4-5` is a trap (it passes `agent`'s validation but
// the spawned scoop silently falls back to the parent model, e.g. opus at ~5x
// the cost — see ai-ecoverse/slicc#1752). Instead we look up the live model
// list and resolve the user's request (or auto-pick the cheapest model) to an
// exact `models` id, which is proven to carry through to the scoop.
const rateModelArg   = flags['rate-model']       || null;   // user request (may be a substring)
let   rateModel      = rateModelArg;                          // resolved to an exact id in main()
const rateContext    = flags['rate-context']      || null;  // e.g. "/workspace/kb"
const rateConcurrency = flags['rate-concurrency'] || '4';   // parallel rating agents
const rateMax        = flags['rate-max']          || '60';  // hard ceiling on rated items
const rateEffort     = !!flags['rate-effort'];              // estimate effort_minutes per item

// Ranking & backpressure flags (local only — shape the plan, not the data source)
const sortArg  = typeof flags.sort === 'string' ? flags.sort.toLowerCase() : null; // null = auto
const focusArg  = typeof flags.focus  === 'string' ? flags.focus  : null; // top-N "now" cap
const budgetArg = typeof flags.budget === 'string' ? flags.budget : null; // time box, e.g. "90m"

// State flags
const noCache = !!flags['no-cache'];               // bypass the rating cache for this run
const includeIgnored = !!flags['include-ignored']; // show items on the done/ignore list anyway
const trustSignals = flags['no-trust-signals'] ? false : true; // deterministic actionable override

const hasRating = !!(rateImportance || rateUrgency || rateSummary || rateEffort);

// ─── Known Monday-Compatible Commands ────────────────────────────────────────

// Work sources, auto-discovered when no positional args are given.
// 'monday' itself intentionally excluded.
const KNOWN_COMMANDS = ['gh', 'slack', 'teams', 'outlook', 'gmail', 'servicenow'];

// Protocol-compatible but personal/high-noise: these implement `<cmd> monday` yet
// are NOT auto-discovered, because a work triage run drowns in them (one 21-day run
// pulled 25 TikTok notifications and zero work items). Name them explicitly to opt in.
const OPT_IN_COMMANDS = ['linkedin', 'tiktok'];

/**
 * Discover which known commands are available on PATH.
 * Returns an array of command names.
 */
async function discoverCommands() {
  const checks = KNOWN_COMMANDS.map(async (cmd) => {
    const r = await exec(`which ${escapeShellArg(cmd)} 2>/dev/null`);
    return r.exitCode === 0 ? cmd : null;
  });
  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

// ─── Sub-Command Dispatch ────────────────────────────────────────────────────

/**
 * Invoke a single sub-command with the monday protocol flags.
 * Returns parsed JSON array of items, or [] on failure.
 */
async function invokeSource(cmd) {
  const fullCmd = `${cmd} monday --limit ${limit} --depth ${depth} --date ${date}`;
  console.error(`[monday] invoking: ${fullCmd}`);

  const result = await exec(fullCmd);

  if (result.exitCode !== 0) {
    console.error(`[monday] WARNING: "${fullCmd}" exited ${result.exitCode}`);
    if (result.stderr) console.error(`  stderr: ${result.stderr.trim()}`);
    return [];
  }

  // Try to parse JSON from stdout
  const raw = result.stdout.trim();
  if (!raw) {
    console.error(`[monday] WARNING: "${cmd}" returned empty stdout`);
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(`[monday] WARNING: "${cmd}" returned non-array JSON`);
      return [];
    }
    // Enforce --limit ourselves. It is documented as "max items per source", but a
    // source that ignores the flag would otherwise silently inflate the run — and
    // when rating is on, every extra item costs one more agent invocation. Trust
    // the contract, verify the result.
    const cap = parseInt(limit, 10);
    if (Number.isFinite(cap) && cap > 0 && parsed.length > cap) {
      console.error(
        `[monday] NOTE: "${cmd}" returned ${parsed.length} items for --limit ${cap}; truncating.`
      );
      return parsed.slice(0, cap);
    }
    return parsed;
  } catch (e) {
    console.error(`[monday] WARNING: "${cmd}" returned invalid JSON: ${e.message}`);
    // Log the first 200 chars for debugging
    console.error(`  output preview: ${raw.slice(0, 200)}`);
    return [];
  }
}

// ─── Merge & Deduplicate ─────────────────────────────────────────────────────

/**
 * Merge arrays of items, deduplicating by `id`.
 */
function mergeItems(arrays) {
  const seen = new Set();
  const merged = [];

  for (const arr of arrays) {
    for (const item of arr) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }

  return merged;
}

// ─── Rating via Agent ────────────────────────────────────────────────────────

/**
 * Fetch the live model catalog via `models --json`.
 * Returns an array of { id, cost: { input, output, ... }, reasoning, ... }.
 * Throws with a clear message if the command is unavailable or unparsable.
 */
async function getModels() {
  const r = await exec('models --json 2>/dev/null');
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    throw new Error(
      "could not read the model catalog via `models --json`. Is the `models` command available?"
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error('`models --json` did not return valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('`models --json` returned no models.');
  }
  return parsed;
}

/**
 * Resolve a requested rating model to an EXACT `models` id.
 *
 * Why resolve here instead of trusting `agent --model`? Because `agent` accepts
 * some aliases that it then fails to apply — notably the bare `claude-haiku-4-5`
 * validates fine but silently spawns the parent model (opus) at ~5x the cost
 * (ai-ecoverse/slicc#1752). Exact ids from `models` are proven to carry through,
 * so we always hand `agent` an exact id and never rely on alias resolution.
 *
 * @param {string|null} requested  user's --rate-model value, or null to auto-pick.
 * @returns {Promise<string>} an exact model id from the catalog.
 */
async function resolveRateModel(requested) {
  const catalog = await getModels();
  const ids = catalog.map((m) => m.id);
  const costOf = (m) => (m.cost?.input || 0) + (m.cost?.output || 0);

  if (requested) {
    // 1. Exact id match — the ideal case.
    if (ids.includes(requested)) return requested;
    // 2. Unique case-insensitive substring match (lets the user pass a short,
    //    memorable fragment like "us.anthropic.claude-haiku").
    const needle = requested.toLowerCase();
    const matches = ids.filter((id) => id.toLowerCase().includes(needle));
    if (matches.length === 1) {
      console.error(`[monday] --rate-model "${requested}" resolved to ${matches[0]}`);
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(
        `--rate-model "${requested}" is ambiguous, matches ${matches.length} models:\n  ` +
        matches.join('\n  ') +
        '\nSpecify a more exact id (see `models`).'
      );
    }
    // 3. No match — fail fast rather than silently falling back to an expensive model.
    throw new Error(
      `--rate-model "${requested}" is not a known model. Available ids (see \`models\`):\n  ` +
      ids.join('\n  ')
    );
  }

  // Auto-pick: cheapest model, preferring a haiku-class model when present
  // (fast + cheap is the right default for bulk triage rating).
  const byCost = [...catalog].sort((a, b) => costOf(a) - costOf(b));
  const haiku = byCost.filter((m) => m.id.toLowerCase().includes('haiku'));
  const pick = (haiku.length ? haiku : byCost)[0];
  console.error(
    `[monday] no --rate-model given; auto-selected cheapest ${haiku.length ? 'haiku-class ' : ''}` +
    `model: ${pick.id} (${pick.cost?.input}/${pick.cost?.output} per MTok)`
  );
  return pick.id;
}


/**
 * Build the agent prompt for rating a single item.
 */
function buildRatingPrompt(item) {
  const parts = [];

  parts.push('You are a rating agent. Analyze the following item and return a JSON object.');
  parts.push('');
  parts.push('## Item');
  parts.push('```json');
  parts.push(JSON.stringify(item, null, 2));
  parts.push('```');
  parts.push('');

  if (rateContext) {
    parts.push(`## Knowledge Base`);
    parts.push(`You have read-only access to a knowledge base at ${rateContext}. Use grep or read_file to pull in relevant context before rating.`);
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('Rate this item based on its content, participants, recency, and context.');
  // Source-specific guidance travels with the item via `rating_hint` (see the
  // monday protocol): each tool explains how to read its own fields, so this
  // aggregator stays generic. Generic fallback covers sources that omit it.
  if (typeof item.rating_hint === 'string' && item.rating_hint.trim()) {
    parts.push('');
    parts.push('### Source guidance');
    parts.push(item.rating_hint.trim());
  } else if (item.meta) {
    parts.push('If the item has a `meta` block, use whatever it carries (relationship to the reader, state, etc.) to judge how much the reader is personally on the hook, and whether the item is already resolved (then it is `fyi`) or not yet ready to act on (keep urgency low).');
  }
  parts.push('');

  if (rateImportance) {
    const [hi, lo] = rateImportance.split('-').map(Number);
    parts.push(`- **importance**: integer from ${lo} (least important) to ${hi} (most important). Consider: who is involved, what is at stake, how many people are affected, and whether it relates to critical work.`);
  } else {
    parts.push('- **importance**: skip (set to 5)');
  }

  if (rateUrgency) {
    const [hi, lo] = rateUrgency.split('-').map(Number);
    parts.push(`- **urgency**: integer from ${lo} (least urgent) to ${hi} (most urgent). Consider: deadlines, how recently it was updated, whether someone is waiting for a response, and whether it is blocking others.`);
  } else {
    parts.push('- **urgency**: skip (set to 5)');
  }

  if (rateSummary) {
    parts.push(`- **summary**: a concise summary of approximately ${rateSummary} characters. Capture the key point, current status, and what action (if any) is needed.`);
  } else {
    parts.push('- **summary**: a one-sentence summary');
  }

  if (rateEffort) {
    parts.push('- **effort_minutes**: your best integer estimate of how many minutes it would take the reader to ACTUALLY handle this — the work itself, not reading it. Be realistic and do not over-estimate; most inbox items are small. Anchors: clicking approve/merge on a PR that is already reviewed, acking a mention, or a one-line reply = 1-2 min; a quick look-then-approve or a short comment = 3-8 min; a genuine review or a considered reply = 15-30 min; real implementation, a deep review, or a long writeup = 60+ min. A pure "confirm" action is almost always 1-2 minutes — reserve larger numbers for items that truly require reading, thinking, or writing.');
  }

  parts.push('- **category**: the single word that best describes what is expected of the reader:');
  parts.push('  - `fyi` — no action; awareness only (already-merged PR, closed/resolved issue, build or release notification, CC/FYI mention).');
  parts.push('  - `confirm` — a quick yes/no decision or acknowledgement: approve, merge an already-reviewed PR, sign off, dismiss. Low effort.');
  parts.push('  - `review` — the reader must read/examine something before deciding: review a PR\'s code, read a doc or proposal.');
  parts.push('  - `respond` — the reader owes a written reply: answer a question, reply to a comment or message, weigh in on a discussion.');
  parts.push('  - `act` — the reader has real work to do: implement a fix, make a change, complete a task.');
  parts.push('  - `waiting` — the reader has done their part and is now waiting on other people (their PR awaiting review/merge, a question they asked awaiting a reply). Something to chase or track, not to build.');
  parts.push('  Choose exactly one. If it is already done or closed, it is `fyi`.');

  parts.push('');
  parts.push('## Output');
  parts.push('Return ONLY a valid JSON object on a single line, no markdown fences, no explanation:');
  const schemaFields = ['"importance": N', '"urgency": N', '"summary": "..."'];
  if (rateEffort) schemaFields.push('"effort_minutes": N');
  schemaFields.push('"category": "fyi|confirm|review|respond|act"');
  parts.push(`{${schemaFields.join(', ')}}`);

  return parts.join('\n');
}

// ─── Rating cache & deterministic signal guard ───────────────────────────────

// Any rating parameter or model change must invalidate cached ratings.
const ratingSignature = [rateImportance, rateUrgency, rateSummary, rateEffort ? 'E' : '', rateContext || '']
  .map((x) => (x == null ? '' : String(x)))
  .join('|');
function cacheKeyFor(item) {
  // Keyed on the item's content AND the rating params AND the resolved model
  // (rateModel is set before any rateItem call) — change any of them, re-rate.
  return hashKey(
    [item.id, item.title, item.subtitle, item.body, item.ts, item.rating_hint, ratingSignature, rateModel]
      .map((x) => (x == null ? '' : String(x)))
      .join('\u0001')
  );
}
// Loaded once, mutated during rating, flushed after. --no-cache starts empty.
const ratingCache = noCache ? {} : readJson(CACHE_FILE, {});
let cacheHits = 0;
function flushCache() {
  if (noCache) return;
  try { writeJson(CACHE_FILE, ratingCache); } catch (e) {
    console.error(`[monday] WARNING: could not write rating cache: ${e.message}`);
  }
}

/**
 * Deterministic actionable override. Trust explicit relationship signals from the
 * source over the rater: if you were asked to review/act on something not closed,
 * or you authored an item still open, it is a to-do — never silently FYI. This
 * closes the gap where a rater buries your own open PR in the FYI pile. Disable
 * with --no-trust-signals.
 */
/**
 * Deterministic disposition guard. Reads ONLY the protocol-standard normalized
 * flags a source may set — so the aggregator stays source-agnostic:
 *   meta.resolved          → done; force `fyi`.
 *   meta.awaiting_you      → your action is requested; keep it a to-do.
 *   meta.waiting_on_others → you're chasing a follow-up; category `waiting`.
 * (meta.not_ready is consumed by the planner, not here.) Disable with
 * --no-trust-signals. A source that sets none of these is unaffected.
 */
function applySignalGuard(rated) {
  if (!trustSignals) return rated;
  const m = rated.meta || {};
  if (m.resolved === true) {
    if (rated.category !== 'fyi') {
      rated.category = 'fyi';
      rated.actionable = false;
      rated.reclassified_by_signal = 'resolved';
    }
    return rated;
  }
  if (m.awaiting_you === true && rated.category === 'fyi') {
    rated.category = 'review';
    rated.actionable = true;
    rated.reclassified_by_signal = 'awaiting_you';
    return rated;
  }
  if (m.waiting_on_others === true && rated.category !== 'waiting') {
    // You've done your part — this is a follow-up to chase, not work to do.
    rated.category = 'waiting';
    rated.actionable = false;
    rated.reclassified_by_signal = 'waiting_on_others';
  }
  return rated;
}

/**
 * Rate a single item by spawning an agent (or reusing a cached rating).
 * Returns the item with importance/urgency/summary/category (+ effort) merged in.
 */
async function rateItem(item) {
  const key = cacheKeyFor(item);
  if (!noCache && ratingCache[key]) {
    cacheHits++;
    const c = ratingCache[key];
    const rated = {
      ...item,
      importance: c.importance ?? 5,
      urgency: c.urgency ?? 5,
      summary: c.summary ?? '',
      category: c.category ?? 'act',
      actionable: !['fyi', 'waiting'].includes(c.category ?? 'act'),
    };
    if (rateEffort) {
      rated.effort_minutes = c.effort_minutes ?? null;
      rated.effort_band = effortBand(rated.effort_minutes);
    }
    return applySignalGuard(rated);
  }
  const prompt = buildRatingPrompt(item);

  // Build the agent command
  let cmd = `agent --model ${escapeShellArg(rateModel)}`;

  // Set read-only paths if rate-context is provided
  if (rateContext) {
    cmd += ` --read-only ${escapeShellArg(`${rateContext},/workspace/`)}`;
  }

  // CWD, allowed commands, and the prompt
  // The agent needs grep and read_file for context lookups
  const allowedCmds = rateContext ? 'grep,rg,cat,find,ls' : 'true';
  cmd += ` . ${allowedCmds}`;

  // Pass the prompt as a single quoted argv, NOT via a temp file. `agent` takes the
  // prompt as its third positional argument, so a file buys nothing — and writing
  // one scratch file per item is actively harmful: in a sandbox that gates writes,
  // each write raises its own approval request (a 147-item run produced 128 of them
  // and never finished). No filesystem writes here means nothing to approve.
  const fullCmd = `${cmd} ${escapeShellArg(prompt)}`;
  const result = await exec(fullCmd);

  if (result.exitCode !== 0) {
    console.error(`[monday] WARNING: rating agent failed for item ${item.id}`);
    if (result.stderr) console.error(`  stderr: ${result.stderr.trim().slice(0, 200)}`);
    return item; // Return unrated
  }

  // Parse the agent's JSON response
  const raw = result.stdout.trim();

  try {
    // The agent might include extra text; find the JSON object
    const jsonMatch = raw.match(/\{[^{}]*"importance"[^{}]*\}/);
    if (!jsonMatch) {
      console.error(`[monday] WARNING: rating agent returned no valid JSON for ${item.id}`);
      console.error(`  output: ${raw.slice(0, 300)}`);
      return item;
    }

    const rating = JSON.parse(jsonMatch[0]);
    const rated = {
      ...item,
      importance: rating.importance ?? 5,
      urgency: rating.urgency ?? 5,
      summary: rating.summary ?? '',
    };
    if (rateEffort) {
      const em = Number(rating.effort_minutes);
      rated.effort_minutes = Number.isFinite(em) && em > 0 ? Math.round(em) : null;
      rated.effort_band = effortBand(rated.effort_minutes);
    }
    // Category is the reader's expected posture (fyi/confirm/review/respond/act).
    // `actionable` is derived from it for backward-compatible consumers.
    const CATEGORIES = ['fyi', 'confirm', 'review', 'respond', 'act', 'waiting'];
    const cat = typeof rating.category === 'string' ? rating.category.toLowerCase().trim() : '';
    rated.category = CATEGORIES.includes(cat) ? cat : 'act'; // default to a to-do, not FYI
    rated.actionable = !['fyi', 'waiting'].includes(rated.category);
    // Cache the rater's raw output (the signal guard is applied on read, not stored).
    ratingCache[cacheKeyFor(item)] = {
      importance: rated.importance,
      urgency: rated.urgency,
      summary: rated.summary,
      category: rated.category,
      effort_minutes: rated.effort_minutes ?? null,
      at: new Date().toISOString(),
    };
    return applySignalGuard(rated);
  } catch (e) {
    console.error(`[monday] WARNING: failed to parse rating for ${item.id}: ${e.message}`);
    console.error(`  output: ${raw.slice(0, 300)}`);
    return item;
  }
}

/**
 * Rate all items with BOUNDED concurrency.
 *
 * A plain Promise.all over the merged list spawns one agent per item all at once —
 * 147 items meant 147 simultaneous model calls, which is how a triage run wedged
 * itself. A small worker pool keeps the run steady and interruptible while still
 * being much faster than serial.
 */
async function rateAllItems(items) {
  const workers = Math.max(1, parseInt(rateConcurrency, 10) || 1);
  console.error(
    `[monday] rating ${items.length} items with model=${rateModel} (concurrency ${workers})...`
  );

  const out = new Array(items.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await rateItem(items[i]);
      done++;
      if (done % 10 === 0 || done === items.length) {
        console.error(`[monday]   rated ${done}/${items.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  return out;
}

// ─── Ranking, Effort & Backpressure ──────────────────────────────────────────

/** value score = importance x urgency. */
const scoreOf = (it) => (it.urgency || 0) * (it.importance || 0);

/** Derive a coarse effort band from a minute estimate. */
function effortBand(mins) {
  if (mins == null) return null;
  if (mins <= 15) return 'quick';
  if (mins <= 60) return 'short';
  return 'deep';
}

/**
 * Parse a human duration into whole minutes. Accepts "90m", "2h", "1h30m",
 * "1.5h", or a bare number (minutes). Returns null if unparsable.
 */
function parseDuration(s) {
  if (!s) return null;
  const str = String(s).trim().toLowerCase();
  if (/^\d+$/.test(str)) return parseInt(str, 10); // bare number = minutes
  let mins = 0;
  let matched = false;
  const h = str.match(/(\d+(?:\.\d+)?)\s*h/);
  if (h) { mins += parseFloat(h[1]) * 60; matched = true; }
  const m = str.match(/(\d+(?:\.\d+)?)\s*m/);
  if (m) { mins += parseFloat(m[1]); matched = true; }
  return matched ? Math.round(mins) : null;
}

/**
 * Return-on-investment: value per minute of effort. Items missing an effort
 * estimate are treated as a middling 30 min so they neither dominate nor vanish.
 */
const EFFORT_UNKNOWN_MIN = 30;
const roiOf = (it) => scoreOf(it) / Math.max(1, it.effort_minutes || EFFORT_UNKNOWN_MIN);

/**
 * Sort items by the chosen mode.
 *   value  — importance x urgency desc (default), ts desc as tie-break
 *   roi    — value per minute desc (quick wins first), value then ts as tie-break
 *   newest — ts desc
 * When not rated, everything collapses to ts desc regardless of mode.
 */
function sortItems(items, rated, mode = 'value') {
  const byTs = (a, b) =>
    (b.ts ? new Date(b.ts).getTime() : 0) - (a.ts ? new Date(a.ts).getTime() : 0);
  return items.sort((a, b) => {
    if (rated && mode === 'roi') {
      const d = roiOf(b) - roiOf(a);
      if (d !== 0) return d;
      const s = scoreOf(b) - scoreOf(a);
      if (s !== 0) return s;
    } else if (rated && mode !== 'newest') {
      const s = scoreOf(b) - scoreOf(a);
      if (s !== 0) return s;
    }
    return byTs(a, b);
  });
}

/**
 * Backpressure: turn a ranked list into a plan of attack. Two axes:
 *
 *   1. TODO vs FYI — items the rater marked `actionable: false` (merged PRs,
 *      closed issues, build notifications, CC mentions) are things to be *aware*
 *      of, not act on. They go to the "fyi" bucket, never consume the time
 *      budget, and are presented as a separate, glanceable list.
 *   2. now vs later — among the actionable TODO items, a doable slice is
 *      promoted to "now" and the rest held as "later":
 *        --focus N   : the top N to-dos are "now".
 *        --budget T  : pack the to-dos whose cumulative effort fits T minutes
 *                      (items with no effort estimate assumed 30 min).
 *        both        : budget packs by time, but never exceeds the focus count.
 *
 * `items` must already be sorted by the chosen mode (ROI by default when effort
 * is present — best bang-for-buck first). Returns the list re-ordered
 * now → later → followup → fyi, each tagged with a `bucket` field, plus plan
 * counts. `followup` holds `waiting` items (you're chasing others — nothing to
 * build). When no plan flag is set AND everything is a plain to-do, planning is
 * a no-op (output stays backward-compatible); any FYI or waiting items, however,
 * still get bucketed so a presenter can separate the lists.
 */
function buildPlan(items) {
  const budgetMin = parseDuration(budgetArg);
  const focusN = focusArg != null ? parseInt(focusArg, 10) : null;
  const focusValid = Number.isFinite(focusN) && focusN >= 0 ? focusN : null;
  const sliceRequested = budgetMin != null || focusValid != null;

  const waiting = items.filter((it) => it.category === 'waiting');
  const fyi = items.filter((it) => it.actionable === false && it.category !== 'waiting');
  const todo = items.filter((it) => it.actionable !== false && it.category !== 'waiting');

  // Nothing to plan and nothing to separate → leave output untouched.
  if (!sliceRequested && fyi.length === 0 && waiting.length === 0) {
    return { items, planning: false };
  }

  let usedMin = 0;
  let nowCount = 0;
  // An item flagged not_ready by its source (a draft or CI-pending PR) isn't
  // ready to act on — hold it for "later" rather than the top, even if it ranks
  // high. Reads the normalized protocol flag, not any source's raw fields.
  const notReadyNow = (it) => it.meta && it.meta.not_ready === true;
  const taggedTodo = todo.map((it) => {
    let inNow = true;
    if (sliceRequested) {
      if (notReadyNow(it)) {
        inNow = false; // not ready (draft / CI pending) → not top of the list
      } else if (budgetMin != null) {
        const cost = it.effort_minutes != null ? Math.max(1, it.effort_minutes) : EFFORT_UNKNOWN_MIN;
        const fitsTime = usedMin + cost <= budgetMin;
        const fitsFocus = focusValid == null || nowCount < focusValid;
        inNow = fitsTime && fitsFocus;
        if (inNow) usedMin += cost;
      } else {
        inNow = nowCount < focusValid;
      }
    }
    // With no slice flag, every to-do is "now" (but still split from FYI/waiting).
    if (inNow) nowCount++;
    return { ...it, bucket: inNow ? 'now' : 'later' };
  });
  const taggedWaiting = waiting.map((it) => ({ ...it, bucket: 'followup' }));
  const taggedFyi = fyi.map((it) => ({ ...it, bucket: 'fyi' }));

  return {
    items: [
      ...taggedTodo.filter((it) => it.bucket === 'now'),
      ...taggedTodo.filter((it) => it.bucket === 'later'),
      ...taggedWaiting,
      ...taggedFyi,
    ],
    planning: true,
    sliceRequested,
    nowCount,
    nowMinutes: usedMin,
    laterCount: taggedTodo.length - nowCount,
    followupCount: taggedWaiting.length,
    fyiCount: taggedFyi.length,
    budgetMin,
    focusN: focusValid,
  };
}


// ─── Main ────────────────────────────────────────────────────────────────────

// ─── Done / ignore list management ────────────────────────────────────────────
// A permanent, personal suppression list: items you mark `done` or `ignore` stay
// out of every future run until you `restore` them. Keyed by the stable item id.
const MGMT_COMMANDS = new Set([
  'done', 'ignore', 'mute', 'unignore', 'unmute', 'restore', 'ignored', 'list-ignored', 'muted', 'cache-clear', 'forget-cache',
]);

function loadSuppress() {
  const s = readJson(SUPPRESS_FILE, { items: {} });
  if (!s.items) s.items = {};
  return s;
}

async function handleManagement(action, ids) {
  if (action === 'ignored' || action === 'list-ignored' || action === 'muted') {
    const store = loadSuppress();
    const list = Object.entries(store.items).map(([id, v]) => ({ id, ...v }));
    console.error(`[monday] ${list.length} item(s) silenced (done/ignore/mute) — ${SUPPRESS_FILE}`);
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (action === 'cache-clear' || action === 'forget-cache') {
    try { writeJson(CACHE_FILE, {}); console.error('[monday] rating cache cleared.'); }
    catch (e) { console.error(`[monday] could not clear cache: ${e.message}`); }
    return;
  }
  // done | ignore | mute | unignore | unmute | restore
  if (ids.length === 0) {
    console.error(`[monday] usage: monday ${action} <id> [<id>...]   (ids come from monday output or the dip's buttons)`);
    process.exit(2);
  }
  const store = loadSuppress();
  const remove = action === 'unignore' || action === 'unmute' || action === 'restore';
  const label = action === 'done' ? 'done' : action === 'mute' ? 'mute' : 'ignore';
  let n = 0;
  for (const id of ids) {
    if (remove) {
      if (store.items[id]) { delete store.items[id]; n++; }
    } else {
      store.items[id] = {
        action: label,
        at: new Date().toISOString(),
        ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
      };
      n++;
    }
  }
  writeJson(SUPPRESS_FILE, store);
  console.error(
    remove
      ? `[monday] un-silenced ${n} item(s); they can resurface in future runs.`
      : `[monday] ${label === 'done' ? 'marked done' : label === 'mute' ? 'muted' : 'ignoring'} ${n} item(s); they won't appear in future runs (monday restore <id> to undo).`
  );
}

async function main() {
  // Management subcommands (done/ignore/restore/ignored/cache-clear) short-circuit
  // the aggregation pipeline entirely.
  if (subcommands.length && MGMT_COMMANDS.has(subcommands[0])) {
    await handleManagement(subcommands[0], subcommands.slice(1));
    return;
  }

  // 1. Determine which sub-commands to run
  let commands = subcommands;

  if (commands.length === 0) {
    console.error('[monday] no sources specified, auto-discovering...');
    commands = await discoverCommands();
    if (commands.length === 0) {
      console.error('[monday] no monday-compatible commands found on PATH');
      console.log('[]');
      return;
    }
    console.error(`[monday] discovered: ${commands.join(', ')}`);
    const optIn = await Promise.all(
      OPT_IN_COMMANDS.map(async (c) => {
        const r = await exec(`which ${escapeShellArg(c)} 2>/dev/null`);
        return r.exitCode === 0 ? c : null;
      })
    );
    const available = optIn.filter(Boolean);
    if (available.length) {
      console.error(`[monday] not included (name explicitly to opt in): ${available.join(', ')}`);
    }
  }

  // 2. Invoke all sources in parallel
  const results = await Promise.all(commands.map(invokeSource));

  // 3. Merge and deduplicate
  let items = mergeItems(results);
  console.error(`[monday] merged ${items.length} items from ${commands.length} sources`);

  // 3b. Drop items on the permanent done/ignore list (unless --include-ignored).
  if (!includeIgnored) {
    const suppress = loadSuppress();
    const before = items.length;
    items = items.filter((it) => !suppress.items[it.id]);
    const hidden = before - items.length;
    if (hidden) {
      console.error(
        `[monday] hid ${hidden} item(s) on your done/ignore list ` +
        `(monday ignored to view · monday restore <id> to unhide · --include-ignored to override).`
      );
    }
  }

  // 4. Rate if any --rate-* flags are present
  if (hasRating && items.length > 0) {
    // Guard rail: rating is one model call per item, so an unexpectedly large merge
    // is expensive and slow. Rate the newest N and pass the rest through unrated
    // rather than silently launching hundreds of calls.
    //
    // `--rate-max 0` must mean ZERO calls, so clamp at 0 rather than 1 — an
    // explicit cap of zero that still spent one paid call would be a lie. A
    // non-numeric value falls back to the documented default instead of 1.
    const parsedMax = parseInt(rateMax, 10);
    const cap = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : 60;
    if (cap === 0) {
      // Rating is explicitly disabled — do NOT resolve the model. Resolving here
      // would let a missing `models` command or a bad --rate-model fail a run
      // that was never going to spend a call. All items pass through unrated.
      console.error(
        '[monday] --rate-max 0: rating disabled, all items pass through unrated.'
      );
    } else {
      // Resolve the rating model to an exact `models` id up front. This both
      // validates the user's --rate-model (fail fast on a typo instead of paying
      // for a wrong model) and sidesteps the alias-fallback trap in `agent`
      // (ai-ecoverse/slicc#1752).
      try {
        rateModel = await resolveRateModel(rateModelArg);
      } catch (e) {
        console.error(`[monday] ${e.message}`);
        process.exit(1);
      }
      if (items.length > cap) {
        console.error(
          `[monday] WARNING: ${items.length} items exceeds --rate-max ${cap}. ` +
          `Rating the ${cap} newest; the rest pass through unrated. ` +
          `Raise --rate-max or lower --limit.`
        );
        const byNewest = sortItems(items, false);
        const rated = await rateAllItems(byNewest.slice(0, cap));
        items = [...rated, ...byNewest.slice(cap)];
      } else {
        items = await rateAllItems(items);
      }
      if (cacheHits) {
        console.error(`[monday] rating cache: reused ${cacheHits} cached rating(s); the rest were freshly rated (--no-cache to disable, monday cache-clear to reset).`);
      }
      flushCache();
    }
  }

  // 5. Sort. Default to ROI (bang-for-buck — impact per minute) whenever effort
  // is available, else value; an explicit --sort always wins. ROI without effort
  // can't be computed, so fall back with a warning rather than a bogus ranking.
  let mode = sortArg;
  if (mode && !['value', 'roi', 'newest'].includes(mode)) {
    console.error(`[monday] unknown --sort "${sortArg}"; using ${rateEffort ? 'roi' : 'value'}.`);
    mode = null;
  }
  if (mode === 'roi' && !rateEffort) {
    console.error(
      '[monday] --sort roi needs --rate-effort; falling back to --sort value. ' +
      'Add --rate-effort to rank by impact-per-minute.'
    );
    mode = 'value';
  }
  if (!mode) mode = rateEffort ? 'roi' : 'value'; // bang-for-buck by default when we can
  items = sortItems(items, hasRating, mode);

  // 6. Backpressure: split TODO vs FYI, and promote a doable "now" slice.
  const plan = buildPlan(items);
  items = plan.items;
  if (plan.planning) {
    const bits = [`${plan.nowCount} to-do now`];
    if (rateEffort && plan.sliceRequested) bits[0] += ` (~${plan.nowMinutes}m)`;
    if (plan.budgetMin != null) bits.push(`budget ${plan.budgetMin}m`);
    if (plan.focusN != null) bits.push(`focus ${plan.focusN}`);
    const tail = [];
    if (plan.laterCount) tail.push(`${plan.laterCount} later`);
    if (plan.followupCount) tail.push(`${plan.followupCount} waiting on others`);
    if (plan.fyiCount) tail.push(`${plan.fyiCount} FYI`);
    console.error(
      `[monday] plan: ${bits.join(', ')}` +
      (tail.length ? ` | ${tail.join(' | ')}` : '') +
      `. Start with the "now" bucket; "later" stays ranked and "FYI" is just for awareness.`
    );
  } else if (hasRating && items.length > 12) {
    // Soft nudge: a big ranked list is still a wall. Point at the tools that
    // turn it into a doable slice  a plan of attack, not a verdict of doom.
    console.error(
      `[monday] ${items.length} items ranked. That's a lot to face at once  ` +
      `add --focus 5 (or --budget 90m with --rate-effort) to get a doable "now" ` +
      `slice; everything else stays ranked for later.`
    );
  }

  // 7. Output
  console.log(JSON.stringify(items, null, 2));
}

await main();
