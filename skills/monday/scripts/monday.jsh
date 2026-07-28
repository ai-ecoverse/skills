// monday.jsh — Aggregator/dispatcher for inbox and todo sources
//
// Usage:
//   monday [source1] [source2] ... [--flags]
//
// Examples:
//   monday gh slack --limit 20 --date 3d
//   monday --rate-importance 9-4 --rate-urgency 8-3 --rate-summary 500
//   monday gh --limit 10 --rate-importance 8-3 --rate-model claude-haiku-4-5
//
// With no positional args, auto-discovers monday-compatible commands on PATH.

// Runtime bridge: the jsh runtime no longer injects `exec` as a bare global;
// obtain it explicitly. `exec` is callable directly.
// (No `fs` import: rating passes prompts as argv, so this script writes nothing.)
const exec = require('sliccy:exec');

// Single POSIX-shell-quote a value for safe interpolation into an exec()
// command line (exec runs through the jsh shell bridge).
function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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
  --rate-model NAME         Model for rating (default claude-haiku-4-5)
  --rate-context PATH       Read-only knowledge base the rater may grep
  --rate-concurrency N      Parallel rating agents (default 4)
  --rate-max N              Refuse to rate more than N items (default 60)

OUTPUT
  JSON array on stdout; progress and warnings on stderr. Sorted by
  urgency x importance when rated, else by timestamp descending.

EXAMPLES
  monday gh --limit 5 --date 1d
  monday slack teams --limit 10 --date 3d
  monday gh --limit 5 --rate-importance 9-1 --rate-urgency 8-1`);
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
const rateModel      = flags['rate-model']       || 'claude-haiku-4-5';
const rateContext    = flags['rate-context']      || null;  // e.g. "/workspace/kb"
const rateConcurrency = flags['rate-concurrency'] || '4';   // parallel rating agents
const rateMax        = flags['rate-max']          || '60';  // hard ceiling on rated items

const hasRating = !!(rateImportance || rateUrgency || rateSummary);

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

  parts.push('');
  parts.push('## Output');
  parts.push('Return ONLY a valid JSON object on a single line, no markdown fences, no explanation:');
  parts.push('{"importance": N, "urgency": N, "summary": "..."}');

  return parts.join('\n');
}

/**
 * Rate a single item by spawning an agent.
 * Returns the item with importance/urgency/summary merged in.
 */
async function rateItem(item) {
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
    return {
      ...item,
      importance: rating.importance ?? 5,
      urgency: rating.urgency ?? 5,
      summary: rating.summary ?? '',
    };
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

// ─── Sorting ─────────────────────────────────────────────────────────────────

/**
 * Sort items. If rated, by urgency*importance descending, then ts descending.
 * Otherwise, by ts descending.
 */
function sortItems(items, rated) {
  return items.sort((a, b) => {
    if (rated) {
      const scoreA = (a.urgency || 0) * (a.importance || 0);
      const scoreB = (b.urgency || 0) * (b.importance || 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
    }
    // Tie-break (or primary if not rated): ts descending
    const tsA = a.ts ? new Date(a.ts).getTime() : 0;
    const tsB = b.ts ? new Date(b.ts).getTime() : 0;
    return tsB - tsA;
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
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

  // 4. Rate if any --rate-* flags are present
  if (hasRating && items.length > 0) {
    // Guard rail: rating is one model call per item, so an unexpectedly large merge
    // is expensive and slow. Rate the newest N and pass the rest through unrated
    // rather than silently launching hundreds of calls.
    const cap = Math.max(1, parseInt(rateMax, 10) || 1);
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
  }

  // 5. Sort
  items = sortItems(items, hasRating);

  // 6. Output
  console.log(JSON.stringify(items, null, 2));
}

await main();
