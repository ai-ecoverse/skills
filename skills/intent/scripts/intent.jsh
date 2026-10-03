// intent — one browser step, stated as an intent: a playwright-cli overlay
// that returns a small result instead of a snapshot.
//   classify:  ACT, RETRIEVE, VERIFY, WAIT_FOR or NAVIGATE (intent.js)
//   filter:    the page's controls or text, ranked by the intent's words;
//              the top few go to System 1 (Clef, or a local kev) as one
//              choice question
//   act/reply: act when System 1 is sure, else return the candidates
// The engine is intent-core.js. `intent serve` runs it as a server for
// callers that may not run playwright-cli themselves (an intent-only agent
// scoop): requests and answers are files under /tmp/intent.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const skill = require('sliccy:skill');
const lib = require('./intent.js');
const { createIntent, WAIT_DEFAULT_S } = require('./intent-core.js');
const kevHost = require('./kev/host.js');
const kevRuntime = require('./kev/kev-runtime.js');

const HELP = `
intent — one browser step, stated as an intent

USAGE
  intent --intent "<what you want>" [--tab ID] [flags]
  intent prepare                install the kev runtime (once)
  intent pull [--model M]       download a kev bundle's weights (default 4b-vision)
  intent serve [--model M]      keep System 1 loaded and do the browser work for
                                callers that may not run playwright-cli themselves

INTENTS (one per call; the kind is read from the words, --kind overrides)
  NAVIGATE  "open https://news.ycombinator.com", "go back", "reload"
  ACT       "click the Search button", "fill the name field with \\"Ada Lovelace\\"",
            "select \\"Medium\\" from the size dropdown", "check the terms box",
            "press Enter", "scroll down", "close the cookie banner"
  RETRIEVE  "what is the total price?", "read the error message"
  VERIFY    "is the cart empty?", "verify the order was placed"
  WAIT_FOR  "wait until the results load"
  Quote text to type or an option to select: type "Berlin" into Where from.

WRITING INTENTS (specific intents act at once; vague ones come back as ?)
  - Name the control by the words on it, quoted when it has several:
    click "Buy and Eat", not "buy the food".
  - Say which one when a label repeats: its row or neighbour (the "BUY" button
    in the Cocaine row) or its place (the first result, the top story's
    comments link).
  - One action per call. Text to type goes in quotes: type "Ada Lovelace"
    into the customer name field.
  - On a ? answer, pass the right ref (--ref e41) instead of rewording.
  - To find one control among many: "list the links about drugs"; to read
    several values: "list the rows that mention calories"; for one value,
    ask a question ("what is the total price?").
  - A ref from an earlier result (e12) still works after the page changes.

FLAGS
  --intent TEXT      required: what you want, in words
  --tab ID           the tab (default: the one the last call used; NAVIGATE
                     to a URL opens a tab when there is none)
  --kind K           act | retrieve | verify | wait_for | navigate
  --ref REF          act on this ref (from an earlier result) instead of choosing
  --sure P           act or answer only when System 1's top choice has
                     probability P or more (default ${lib.SURE})
  --candidates N     list the top N candidates with their probabilities; do nothing
  --dry-run          ACT: say which control it would use, without acting
  --full             print the whole page snapshot (the escape hatch)
  --timeout S        WAIT_FOR: give up after S seconds (default ${WAIT_DEFAULT_S})
  --model M          System 1: 4b-vision (default) | 0.8b-vision | 4b | 0.8b, a
                     local kev bundle; clef | clef-flash on Cloudflare Workers AI
                     (needs the CLOUDFLARE_API_TOKEN secret and --cf-account once)
  --from DIR|URL     a kev bundle instead of a named one (a fine-tune): a VFS
                     directory, or a bundle directory's URL (fetched once)
  --require-gpu      stop when WebGPU is a software adapter (SwiftShader), where
                     kev runs ~10x slower, instead of carrying on
  --retrieve MODE    answer (default): the one text that answers, or the closest
                     few when unsure; budget: the top texts by System 1 until
                     --retrieve-budget characters (default 1200), in page order;
                     lexical: the same ranked by words alone, no model
  --json             print the result as JSON

OUTPUT
  ✓ what was done, then what changed (address, values, new controls)
  ?  System 1 was not sure: nothing was done; the candidates follow, each
     with its ref. Say more in --intent, or pass --ref.
  A result names refs (e12) that the next call can pass as --ref.
`.trim();

const { handle, serve, viaDaemon } = createIntent({
  exec,
  fs,
  browser,
  skill,
  // Named here, in the entry script: see kev-runtime.js loadKev.
  requireBundle: () => require('/shared/cache/kev/bundle.cjs'),
});

// ── main ──────────────────────────────────────────────────────────────

function requestFromFlags(flags) {
  const pick = (...names) => names.map((n) => flags[n]).find((v) => v !== undefined);
  const bool = (v) => (v === undefined ? undefined : v === true || /^(1|true|yes|on)$/i.test(String(v)));
  const raw = {
    intent: typeof flags.intent === 'string' ? flags.intent : undefined,
    kind: pick('kind'),
    ref: pick('ref'),
    tab: pick('tab'),
    sure: pick('sure'),
    candidates: pick('candidates'),
    dryRun: bool(pick('dry-run')),
    full: bool(pick('full')),
    timeout: pick('timeout'),
    json: bool(pick('json')),
    model: pick('model'),
  };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  return raw;
}

async function main() {
  const parsed = process.argv.parseFlags();
  const flags = parsed.flags;
  const sub = parsed.positional[0] || '';
  if (flags.help || flags.h || sub === 'help') cli.help(HELP);
  if (sub === 'serve') {
    await serve(flags);
    return;
  }
  if (sub === 'prepare') {
    // A bundle built in this process cannot be required by it: the next
    // intent call loads it.
    await kevHost.ensureBundle(exec, fs, {
      entry: `${__dirname}/kev/kev-entry.mjs`,
      outfile: kevRuntime.BUNDLE,
      packages: [{ spec: kevRuntime.KEV_SPEC, name: kevRuntime.KEV_NAME }],
    });
    const ort = await kevHost.ensureOrt(exec, fs);
    console.log(`kev runtime ready: ${kevRuntime.KEV_SPEC}, ${kevHost.ORT_SPEC} (${ort.dir})`);
    return;
  }
  if (sub === 'pull') {
    const model = typeof flags.model === 'string' ? flags.model : '4b-vision';
    if (!kevRuntime.MODELS[model]) cli.die(`--model is one of ${Object.keys(kevRuntime.MODELS).join(', ')}`, { prefix: 'intent' });
    const status = await kevRuntime.pullWeights(fs, exec, model, (line) => console.error(line));
    if (status.missing.length) cli.die(`${status.missing.length} files are still missing; run intent pull again (it resumes)`, { prefix: 'intent' });
    console.log(`kev-${model}: ready in ${status.base}`);
    return;
  }
  if (sub) cli.die(`unknown command: ${sub}\nRun 'intent --help' for usage.`, { prefix: 'intent' });
  if (flags.intent === true) {
    cli.die('--intent needs text; an intent that starts with "-" goes as --intent="-…"', { prefix: 'intent' });
  }
  const { req, error } = lib.cleanRequest(requestFromFlags(flags));
  if (error) cli.die(error, { prefix: 'intent' });
  let answer = flags.local ? null : await viaDaemon(req);
  if (!answer) answer = await handle(req, flags);
  if (answer.stdout) console.log(answer.stdout);
  if (answer.stderr) console.error(answer.stderr);
  // process.exit: a pending timer (a hung CDP call raced by settle) must
  // not hold the result back.
  process.exit(answer.exitCode || 0);
}

try {
  await main();
} catch (err) {
  if (err?.name === 'NodeExitError') throw err;
  cli.die(String(err?.message || err), { prefix: 'intent' });
}
