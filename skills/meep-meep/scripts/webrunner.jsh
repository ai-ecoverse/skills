// webrunner — one snapshot, one typed decision, one browser action.
// The decision is a single choice over concrete actions, each naming a ref
// from the latest playwright-cli snapshot. With --decider kev the model is
// loaded once per run and asked every step; with --decider agent each step
// is one `agent` call whose StructuredOutput names the action (and the text,
// for a type action).

const agent = require('sliccy:agent');
const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const page = require('./page.js');
const host = require('../../decide-quickly/scripts/host.js');
const kevRuntime = require('../../decide-quickly/scripts/kev-runtime.js');

const LOG_PATH = '/tmp/meep/webrunner.log';
const KEV_SCRIPT = `${__dirname}/../../decide-quickly/scripts/kev.jsh`;
const READY = 'WEBRUNNER_KEV_READY';
const MAX_STEPS_DEFAULT = 8;
const STALL_LIMIT = 3;
const AGENT_MODEL_DEFAULT = 'claude-haiku-4-5';

const HELP = `
webrunner — a browser loop with a typed action space

USAGE
  webrunner run --url <url> --goal <text> [--expect <text>] [--expect-url <text>]
                [--max-steps 8] [--decider kev|agent] [--model <m>] [--from <dir>] [--json]
  webrunner demo link|search|flights [--decider kev|agent] [--model <m>] [--json]

  run                  Open the url and step until the check passes, the model is
                       stuck, or the step cap
  demo link            Open a local page and click the incompleteness article
  demo search          Type London into a local flight field and click Search
  demo flights         Search Berlin to London on Google Flights

  --decider kev        the local Kev model (default). --model 0.8b|4b|9b, default 9b.
                       Needs its weights: kev pull --model 9b (slicc's hf, 8.8 GB)
  --decider agent      one \`agent\` call per step. --model is any id the \`models\`
                       command lists, default ${AGENT_MODEL_DEFAULT}
  --json               print the run summary as JSON (steps, seconds, result)

Each step offers one list of actions: type into a field, click a control, or wait.
Every action names a ref from the latest snapshot, and playwright-cli applies that
ref. With --expect or --expect-url the check decides success and DONE is not
offered. Without them, DONE is offered and checked by a yes/no on a new snapshot.
Three actions that leave the page unchanged stop the run.

Progress is appended to ${LOG_PATH} (the shell shows it only at exit), and
each step's state and menu to /tmp/meep/step-<n>.txt.
`.trim();

const LINK_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Library</title>
<h1>Library</h1>
<p>Pick an article.</p>
<p><a href="#godel">Incompleteness theorems</a></p>
<p><a href="#other">Other article</a></p>
<h2 id="godel">G&ouml;del</h2>
`;

const SEARCH_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Flights</title>
<h1>Flights</h1>
<label>Where to? <input aria-label="Where to?" placeholder="Where to?"></label>
<p><a href="#london">Search</a></p>
`;

const t0 = Date.now();
async function say(line) {
  const stamped = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`;
  console.error(stamped);
  try {
    const old = (await fs.exists(LOG_PATH)) ? await fs.readFile(LOG_PATH) : '';
    await fs.writeFile(LOG_PATH, `${old}${stamped}\n`);
  } catch {
    // The log is a convenience for watching a long run.
  }
}

async function sh(argv) {
  const result = await exec.spawn(argv);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`${argv[0]} ${argv[1] || ''} failed (${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

function previewUrl(vfsPath) {
  const path = vfsPath.startsWith('/') ? vfsPath : `/${vfsPath}`;
  const origin =
    typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost:8787';
  return `${origin}/preview${path}`;
}

// ── deciders ──────────────────────────────────────────────────────────

// Each call spawns a scoop that may run no command; its StructuredOutput is
// the decision. The scoop is billed like any other: see `cost`.
function agentDecider(flags) {
  const model = flags.model || AGENT_MODEL_DEFAULT;
  const ask = (prompt, schema) =>
    agent(prompt, {
      model,
      thinking: 'off',
      schema,
      cwd: '/tmp/meep',
      allowedCommands: 'true',
      readOnly: '/tmp/meep/',
    });
  return {
    name: `agent ${model}`,
    async decide(state, menu) {
      const answer = await ask(page.agentPrompt(state, menu), page.decisionSchema(menu));
      const action = page.pickAction(menu, answer && answer.action);
      if (action.operation !== 'TYPE_TEXT' || action.text) return { action };
      const text = typeof answer.text === 'string' ? answer.text.trim() : '';
      if (!text || text.length > 2000) throw new Error(`${action.id} came back without text`);
      return { action: { ...action, text } };
    },
    async finished(state) {
      const answer = await ask(page.finishedPrompt(state), page.FINISHED_SCHEMA);
      return Boolean(answer && answer.finished === true);
    },
  };
}

// The runtime must be installed before this process starts: a bundle that
// kev writes now is invisible to our require(). `kev prepare` installs it in
// a child, then this script runs itself once more.
async function ensureKevRuntime() {
  if (await kevRuntime.ready(fs)) return;
  if (process.env[READY] === '1') {
    cli.die('kev prepare finished but the runtime is still missing. Run kev prepare, then retry.', {
      prefix: 'webrunner',
    });
  }
  await say('installing the kev runtime (kev prepare)');
  await sh(['node', KEV_SCRIPT, 'prepare']);
  await host.reexec(exec, READY);
}

async function kevDecider(flags) {
  const size = flags.model || '9b';
  if (!kevRuntime.MODELS[size]) {
    cli.die('--model must be 0.8b, 4b, or 9b with --decider kev', { prefix: 'webrunner' });
  }
  if (!flags.from) {
    const status = await kevRuntime.weightsStatus(fs, size);
    if (status.missing.length) cli.die(kevRuntime.missingWeightsMessage(status), { prefix: 'webrunner' });
  }
  await ensureKevRuntime();
  await say(`loading kev ${size}`);
  const loadStarted = Date.now();
  const model = await kevRuntime.openModel(fs, exec, {
    model: size,
    from: flags.from || null,
    log: (line) => {
      if (/phase (ready|session)|runtime|failed/.test(line)) say(line);
    },
    // Named here, in the entry script: see kev-runtime.js loadKev.
    requireBundle: () => require('/shared/cache/kev/bundle.cjs'),
  });
  const loadMs = Date.now() - loadStarted;
  await say('kev loaded');
  return {
    name: `kev ${size}`,
    loadMs,
    async decide(state, menu) {
      const response = await model.systemOne({
        state,
        questions: { action: page.menuQuestion(menu) },
      });
      const answer = response.answers.action;
      const top = Object.entries(answer.probabilities || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, p]) => `${id}=${p}`)
        .join(' ');
      const action = page.pickAction(menu, answer.choice);
      if (action.operation === 'TYPE_TEXT' && !action.text) {
        throw new Error('kev picked a field, but the goal has no value for it. Quote the text in --goal.');
      }
      return { action, confidence: answer.confidence, top };
    },
    async finished(state) {
      const response = await model.systemOne({
        state,
        questions: {
          finished: { type: 'noul', instructions: 'Does this page show every part of the goal finished?' },
        },
      });
      return response.answers.finished.noul >= 0.5;
    },
  };
}

// ── browser ───────────────────────────────────────────────────────────

async function openTab(url) {
  const stdout = await sh(['playwright-cli', 'open', url, '--foreground']);
  const match = /targetId:\s*([^\]\s]+)/.exec(stdout);
  if (match) return match[1];
  throw new Error(`playwright-cli open did not report a tab: ${stdout.slice(0, 240)}`);
}

async function readShot(tab) {
  const raw = await sh(['playwright-cli', 'snapshot', `--tab=${tab}`]);
  const shot = page.parseSnapshot(raw);
  shot.raw = raw;
  return shot;
}

// playwright-cli open returns while the tab still shows about:blank, and a
// step spent there is a model call with nothing to choose (seen 2026-09-23).
async function waitForPage(tab) {
  for (let i = 0; i < 20; i++) {
    const shot = await readShot(tab);
    if (shot.url && shot.url !== 'about:blank' && shot.elements.length) return;
    await sh(['sleep', '0.5']);
  }
}

// playwright-cli maps a ref to its DOM node by role + accessible name. When
// the page's name has stray whitespace (Google Flights labels its inputs
// "Where from? ") that join misses, and the [aria-label="…"] fallback
// misses too (seen 2026-09-22; fixed in ai-ecoverse/slicc#3417, kept for
// older builds). Then find the node by its trimmed name, focus it in the
// page, and let playwright-cli send real keystrokes.
function focusByName(element, click) {
  return `(() => {
    const want = ${JSON.stringify(element.label)}.replace(/\\s+/g, ' ').trim();
    const role = ${JSON.stringify(element.role)};
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const nameOf = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText);
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const all = [...document.querySelectorAll('[aria-label], [placeholder], [role], a, button, input')];
    const hits = all.filter((el) => visible(el) && nameOf(el) === want);
    hits.sort((a, b) => ((b.getAttribute('role') || b.tagName).toLowerCase() === role) - ((a.getAttribute('role') || a.tagName).toLowerCase() === role));
    const el = hits[0];
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${click ? 'true' : 'false'}) el.click();
    if ('value' in el && !${click ? 'true' : 'false'}) el.select && el.select();
    return 'ok';
  })()`;
}

const SELECT_FOCUSED = `(() => {
  const el = document.activeElement;
  if (el && typeof el.select === 'function') el.select();
  return 'ok';
})()`;

async function act(tab, action) {
  if (action.operation === 'WAIT') {
    await sh(['sleep', '0.5']);
    return '';
  }
  const ref = action.element.token;
  // Text goes in as keystrokes. `fill` sets the value, but Google Flights'
  // "Where to?" then opens an empty overlay with no suggestions, and its
  // Return date field drops the value (both seen 2026-09-23). Click the
  // field, select what is there, and type.
  const keystrokes = action.operation === 'TYPE_TEXT';
  const result = await exec.spawn(['playwright-cli', 'click', `--tab=${tab}`, ref]);
  if (result.exitCode === 0) {
    if (!keystrokes) return result.stdout || '';
    await sh(['sleep', '0.3']);
    await sh(['playwright-cli', 'eval', `--tab=${tab}`, SELECT_FOCUSED]);
    return sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text]);
  }
  const detail = `${result.stderr || ''}${result.stdout || ''}`;
  if (!/Element not found|Unknown ref/.test(detail)) {
    throw new Error(`playwright-cli click ${ref} failed: ${detail.trim().slice(0, 300)}`);
  }
  await say(`         ${ref} has no node id; focusing "${action.element.label.trim()}" by name`);
  const focused = await sh([
    'playwright-cli',
    'eval',
    `--tab=${tab}`,
    focusByName(action.element, action.operation === 'CLICK'),
  ]);
  if (!focused.includes('ok')) throw new Error(`no visible control named "${action.element.label.trim()}"`);
  if (action.operation === 'TYPE_TEXT') {
    await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text]);
  }
  return focused;
}

// Google shows a consent wall outside the US. It covers the form, so it is
// dismissed before the loop rather than spending a model step on it.
async function dismissConsent(tab) {
  const shot = await readShot(tab);
  if (!shot.url.includes('consent.google.') && !/Before you continue/.test(shot.raw)) return;
  const reject = shot.elements.find((e) => e.kind === 'click' && /^reject all$/i.test(e.label));
  if (!reject) return;
  await say(`consent: click ${reject.token} "${reject.label}"`);
  await sh(['playwright-cli', 'click', `--tab=${tab}`, reject.token]);
  await sh(['sleep', '1']);
}

function expected(shot, flags) {
  if (!flags.expect && !flags['expect-url']) return false;
  if (flags['expect-url'] && !shot.url.includes(flags['expect-url'])) return false;
  if (flags.expect && !shot.raw.includes(flags.expect)) return false;
  return true;
}

// ── loop ──────────────────────────────────────────────────────────────

async function makeDecider(flags) {
  const name = flags.decider || 'kev';
  if (name === 'agent') return agentDecider(flags);
  if (name === 'kev') return kevDecider(flags);
  return cli.die('--decider is kev or agent', { prefix: 'webrunner' });
}

async function runGoal(flags) {
  if (!flags.url) cli.die('--url is required', { prefix: 'webrunner' });
  if (!flags.goal) cli.die('--goal is required', { prefix: 'webrunner' });
  await fs.mkdir('/tmp/meep', { recursive: true });
  await fs.writeFile(LOG_PATH, '');
  const parsedMax = parseInt(flags['max-steps'], 10);
  const maxSteps = Number.isFinite(parsedMax) ? Math.min(Math.max(parsedMax, 1), 50) : MAX_STEPS_DEFAULT;
  const hasCheck = Boolean(flags.expect || flags['expect-url']);
  const started = Date.now();
  const decider = await makeDecider(flags);
  // The agent writes the text for a type action itself; kev can only pick
  // values that the goal spells out.
  const candidates = flags.decider === 'agent' ? [] : page.textCandidates(flags.goal);
  const result = {
    ok: false,
    reason: '',
    decider: decider.name,
    steps: 0,
    seconds: 0,
    loadSeconds: decider.loadMs == null ? null : decider.loadMs / 1000,
    decideSeconds: 0,
    url: flags.url,
  };
  const finish = (ok, reason, url) => {
    result.ok = ok;
    result.reason = reason;
    if (url) result.url = url;
    result.seconds = (Date.now() - started) / 1000;
    result.decideSeconds = Math.round(result.decideSeconds * 10) / 10;
    return result;
  };

  const tab = await openTab(flags.url);
  await say(`tab ${tab} ${flags.url}`);
  await waitForPage(tab);
  await dismissConsent(tab);
  const history = [];
  let previousLabels = null;
  let stalls = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const shot = await readShot(tab);
    if (expected(shot, flags)) {
      await say(`step ${step}  verified: ${shot.url}`);
      return finish(true, 'check passed', shot.url);
    }
    const menu = page.buildMenu(shot, flags.goal, { candidates, previousLabels, offerDone: !hasCheck });
    const state = page.compactState(flags.goal, shot, menu, history);
    await fs.writeFile(`/tmp/meep/step-${step}.txt`, `${state}\n\nMenu:\n${menu.map((a) => `  ${a.id}  ${a.describe}`).join('\n')}\n`);
    const decideStarted = Date.now();
    // With nothing to act on, WAIT is the only choice: no model call.
    const decision = menu.length === 1 ? { action: menu[0] } : await decider.decide(state, menu);
    const decideMs = Date.now() - decideStarted;
    result.decideSeconds += decideMs / 1000;
    result.steps = step;
    const action = decision.action;
    const conf = decision.confidence == null ? '' : ` conf=${decision.confidence}`;
    const typed = action.operation === 'TYPE_TEXT' && !/^type "/.test(action.describe) ? ` "${action.text}"` : '';
    await say(`step ${step}  ${action.describe}${typed}  (${decideMs} ms${conf})`);
    if (decision.top) await say(`         top ${decision.top}`);

    if (action.operation === 'DONE') {
      const after = await readShot(tab);
      const afterMenu = page.buildMenu(after, flags.goal, { candidates });
      if (await decider.finished(page.compactState(flags.goal, after, afterMenu, history))) {
        await say(`step ${step}  done, confirmed on a second snapshot`);
        return finish(true, 'done, confirmed on a second snapshot', after.url);
      }
      await say(`step ${step}  DONE not confirmed by the second snapshot`);
    } else {
      await act(tab, action);
      history.push({
        operation: action.operation,
        text: action.text || null,
        label: action.element ? action.element.label : '',
        role: action.element ? action.element.role : '',
      });
    }

    // Suggestion lists render a beat after the keystroke.
    await sh(['sleep', action.operation === 'TYPE_TEXT' ? '0.6' : '0.3']);
    const after = await readShot(tab);
    if (expected(after, flags)) {
      await say(`step ${step}  verified: ${after.url}`);
      return finish(true, 'check passed', after.url);
    }
    stalls = page.fingerprint(after) === page.fingerprint(shot) ? stalls + 1 : 0;
    if (stalls >= STALL_LIMIT) {
      return finish(false, `${STALL_LIMIT} actions in a row left the page unchanged`, after.url);
    }
    previousLabels = new Set(shot.elements.map((element) => element.label));
  }
  return finish(false, `stopped after ${maxSteps} steps without passing the check`);
}

function report(result, flags) {
  if (flags.json) cli.out(result);
  else if (result.ok) {
    const load = result.loadSeconds == null ? '' : `load ${result.loadSeconds.toFixed(1)} s, `;
    console.log(
      `${result.steps} steps, ${result.seconds.toFixed(1)} s (${result.decider}: ${load}decisions ${result.decideSeconds.toFixed(1)} s)`
    );
    console.log(result.url);
  }
  if (!result.ok) cli.die(result.reason, { prefix: 'webrunner' });
}

// "Oct 7", the way Google Flights' date fields accept it.
function shortDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

function demoGoal(name) {
  if (name === 'link') {
    return {
      page: ['/tmp/meep/link.html', LINK_HTML],
      goal: 'Open the article about incompleteness theorems.',
      'expect-url': '#godel',
      'max-steps': '4',
    };
  }
  if (name === 'search') {
    return {
      page: ['/tmp/meep/search.html', SEARCH_HTML],
      goal: 'Enter "London" in Where to, then press Search.',
      expect: 'London',
      'expect-url': '#london',
      'max-steps': '6',
    };
  }
  if (name === 'flights') {
    return {
      url: 'https://www.google.com/travel/flights?hl=en&gl=us&curr=USD',
      // Google opens a date picker instead of searching when no dates are set.
      goal: `Search Google Flights from Berlin to London. Type Berlin into Where from and pick the Berlin suggestion, type London into Where to and pick the London suggestion. Type "${shortDate(7)}" into Departure and "${shortDate(14)}" into Return, then press Search. Keep Round trip, Economy and one passenger.`,
      expect: 'London',
      'expect-url': '/travel/flights/search',
      'max-steps': '12',
    };
  }
  return cli.die('demo is link, search, or flights', { prefix: 'webrunner' });
}

async function demo(name, flags) {
  const spec = demoGoal(name);
  await fs.mkdir('/tmp/meep', { recursive: true });
  if (spec.page) await fs.writeFile(spec.page[0], spec.page[1]);
  const { page: local, ...goal } = spec;
  return runGoal({
    ...goal,
    url: local ? previewUrl(local[0]) : goal.url,
    decider: flags.decider,
    model: flags.model,
    from: flags.from,
  });
}

async function main() {
  const parsed = host.normalizeFlags(process.argv.parseFlags(), ['json', 'help', 'h']);
  const flags = parsed.flags;
  const sub = parsed.subcommand || '';
  if (flags.help || flags.h || !sub || sub === 'help') {
    cli.help(HELP);
    return;
  }
  try {
    let result;
    if (sub === 'run') result = await runGoal(flags);
    else if (sub === 'demo') result = await demo(parsed.positional[1] || '', flags);
    else cli.die(`unknown command: ${sub}`, { prefix: 'webrunner' });
    report(result, flags);
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'webrunner' });
  }
}

await main();
