// webrunner — an OODA loop over a browser tab.
//   Observe: one playwright-cli snapshot (with boxes), the viewport, a screenshot.
//   Orient:  page.js keeps what is on screen, diffs it against the last
//            observation, and builds one menu of concrete actions.
//   Decide:  one choice over that menu, by kev (loaded once per run) or by
//            one `agent` call whose StructuredOutput names the action.
//   Act:     playwright-cli applies the chosen ref.
// The next cycle's observation is the feedback on this cycle's action.
// Every cycle is written to /tmp/meep/runs/<id>/trace.jsonl for `webrunner debug`.

const agent = require('sliccy:agent');
const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const page = require('./page.js');
const traceLib = require('./trace.js');
const vision = require('./vision.js');
const pageScan = require('./page-scan.js');
const host = require('../../decide-quickly/scripts/host.js');
const kevRuntime = require('../../decide-quickly/scripts/kev-runtime.js');

const LOG_PATH = '/tmp/meep/webrunner.log';
const KEV_SCRIPT = `${__dirname}/../../decide-quickly/scripts/kev.jsh`;
const DEBUG_PAGE = `${__dirname}/../assets/debug.html`;
const READY = 'WEBRUNNER_KEV_READY';
// The parent's deadline (epoch ms) for a run that re-executes itself after
// kev prepare, and how much earlier the child's limit fires.
const DEADLINE_ENV = 'WEBRUNNER_DEADLINE';
const CHILD_MARGIN_MS = 5000;
const MAX_STEPS_DEFAULT = 8;
// A game tour takes 40 steps a day; 50 cut a 100-mile tour short (2026-10-01).
const MAX_STEPS_CAP = 1000;
// A trivial agent() call wrote its ~11K-token system prompt and tools to the
// prompt cache every time and never read them back ($0.027 a call, measured
// 2026-10-02); a System 2 hand-over came to about $0.05. With slicc#3760,
// --minimal sends a short decision prompt with only StructuredOutput, and
// --agent-session keeps one resumed conversation per kind of call, so
// earlier turns are cache reads.
const SESSION_TURNS = 15;
const TIME_LIMIT_CAP = 86400;
// --decider hybrid audits System 1 at this base chance per turn (page.oversightChance).
const OVERSIGHT_DEFAULT = 0.01;
const STALL_LIMIT = 3;
const AGENT_MODEL_DEFAULT = 'claude-sonnet-5-5';
// Below this kev confidence, --decider hybrid hands the step to the agent.
const SHRUG_DEFAULT = 0.5;
// System 2 deliberates, so it gets a stronger model and room to think.
const SYSTEM2_MODEL_DEFAULT = 'claude-sonnet-5-5';
// Deciders whose model writes the text of a type action itself.
const AGENT_WRITES_TEXT = new Set(['agent', 'system2']);
const SYSTEM2_THINKING_DEFAULT = 'low';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const HELP = `
webrunner — a browser loop with a typed action space

USAGE
  webrunner run --url <url> --goal <text> [--expect <text>]... [--expect-url <text>]...
                [--max-steps 8] [--decider kev|agent|hybrid|system2] [--model <m>] [--from <dir>]
                [--agent-model <m>] [--agent-thinking low] [--shrug 0.5] [--plan on|off]
                [--oversight 0.01] [--seed N]
                [--vision] [--window WxH] [--page-text on|off] [--viewport on|off] [--shots on|off]
                [--factor-text on|off] [--json]
  webrunner demo link|search|flights [--decider kev|agent|hybrid|system2] [--model <m>] [--json]
  webrunner debug [<run-id>]

  run                  Open the url and step until the check passes, the model is
                       stuck, or the step cap
  demo link            Open a local page and click the incompleteness article
  demo search          Type London into a local flight field and click Search
  demo flights         Search Berlin to London on Google Flights
  debug                Open the step-by-step page for the latest run (or <run-id>)

  --decider kev        the local Kev model (default). --model 0.8b|4b|9b, default 9b.
                       Needs its weights: kev pull --model 9b (slicc's hf, 8.8 GB)
  --decider agent      one \`agent\` call per step. --model is any id the \`models\`
                       command lists, default ${AGENT_MODEL_DEFAULT}
  --decider system2    System 2 alone on every step (--model, default ${SYSTEM2_MODEL_DEFAULT}):
                       the plan, trail, notes and screenshots of hybrid, without kev
  --decider hybrid     kev decides (System 1, --model as for kev); when it shrugs the
                       step goes to the agent (System 2, --agent-model, default
                       ${SYSTEM2_MODEL_DEFAULT}, thinking --agent-thinking ${SYSTEM2_THINKING_DEFAULT}). It shrugs when it
                       picks SHRUG, its confidence is below --shrug (default ${SHRUG_DEFAULT}) and
                       under 3x the runner-up, or it picks a field the goal gives no text
                       for. System 2 reads the recent steps, the plan and the notes, looks
                       at the page, and may rewrite the plan, add notes and leave up to
                       ${page.MAX_VALUES} values for System 1 to type, all read by System 1 from then on.
                       It writes the first plan before step 1 (--plan off skips that).
                       When kev hands over 6 of 10 steps or 5 in a row, System 2 runs a
                       plan review: no action, a rewritten plan, notes and values, then
                       kev decides again. Even when kev is sure, System 2 audits
                       a turn at random: --oversight (default ${OVERSIGHT_DEFAULT}) per turn, more
                       after a big change or a long calm; --seed makes it repeatable
  --agent-session      System 2 keeps one resumed agent session per kind of call
                       (decisions, plan reviews), rotated every ${SESSION_TURNS} turns, so
                       earlier turns are cache reads (slicc#3760). Without it, each
                       call is a one-shot; both use agent --minimal when available
  --model clef|clef-flash
                       System 1 is Cloudflare's Clef decision model on Workers AI
                       instead of local kev (same questions, screenshot included
                       with --vision). Needs the CLOUDFLARE_API_TOKEN secret
                       (domain api.cloudflare.com) and --cf-account <id> or
                       CLOUDFLARE_ACCOUNT_ID
  --vision             also show the decider the screenshot, each offered control boxed
                       and labelled with its ref. kev needs --model 4b-vision (the
                       default with --vision) or 0.8b-vision; the agent views the
                       image attached to its prompt (slicc agent --image)
  --window WxH         resize the browser's viewport before the first step (device
                       scale 1). With --vision the default is 1024x576, the size kev's
                       vision input takes, so the screenshot is not scaled
  --page-text off      leave the page's text out of the state (controls only)
  --viewport off       offer every control in the snapshot, not only the visible ones
  --factor-text off    kev: one option per field and goal value, instead of picking
                       the field first and its text in a second, small question
  --shots off          skip the per-step screenshot
  --require-gpu        kev: stop when WebGPU in this worker is a software
                       adapter (SwiftShader) instead of running ~10x slower
  --time-limit S       end the run after S seconds, kev loading included, even
                       mid-step: the result says which step and what it was
                       waiting on (a kev decision, an agent call). Default none
  --json               print the run summary as JSON (steps, seconds, result)

Each cycle observes the page, offers one list of actions (type into a field,
click a control, scroll, or wait), asks the decider for one, and applies it.
Every action names a ref from the latest snapshot. Controls outside the
viewport are left out unless the goal names them; SCROLL_DOWN and SCROLL_UP
reach the rest. With --expect or --expect-url (each may repeat; all must
match) the check decides success and
DONE is not offered. Without them, DONE is offered and checked on the next
observation. Three actions that leave the page unchanged stop the run.

Progress is appended to ${LOG_PATH} (the shell shows it only at exit). Each
run's steps, menus, decisions, screenshots and commands go to
/tmp/meep/runs/<id>/; \`webrunner debug\` shows them.
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
// Where the run is, for a --time-limit that expires mid-step: the reason
// names the step and what it was waiting on. stopped: the limit ended the
// run, and a step still in flight must not act or finish again.
const status = { step: 0, phase: 'starting', stopped: false, deadline: 0, child: null };
const stuckAt = () => (status.step ? `step ${status.step}, ${status.phase}` : status.phase);
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

// Every playwright-cli call of a cycle is recorded for the debug page.
async function run(argv, rec) {
  const started = Date.now();
  const result = await exec.spawn(argv);
  if (rec) {
    rec.push({
      argv: argv.map((arg) => traceLib.clip(arg, 300)),
      exitCode: result.exitCode,
      ms: Date.now() - started,
      stdout: traceLib.clip(result.stdout, 1200),
      stderr: traceLib.clip(result.stderr, 1200),
    });
  }
  return result;
}

async function sh(argv, rec) {
  const result = await run(argv, rec);
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

// The browser size: --window WxH, else the vision input size with --vision,
// else the tab's own size.
const VISION_WINDOW = { width: 1024, height: 576 };
function parseWindow(value, vision) {
  if (value === undefined || value === true || value === '') return vision ? VISION_WINDOW : null;
  if (/^(off|none)$/i.test(String(value))) return null;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(value));
  if (!m) cli.die('--window is WIDTHxHEIGHT, e.g. 1024x576', { prefix: 'webrunner' });
  return { width: Number(m[1]), height: Number(m[2]) };
}

function numberFlag(value, fallback, min, max) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// --flag alone is on; --flag off|false|no|0 is off; absent is the default.
function onOff(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) return true;
  return !/^(off|false|no|0)$/i.test(String(value));
}

// ── deciders ──────────────────────────────────────────────────────────

// Each call spawns a scoop that may run no command; its StructuredOutput is
// the decision. The scoop is billed like any other: see `cost`.
// What this slicc's `agent` can do. A scoop's allowedCommands is not a hard
// allowlist: an unlisted command escalates to the cone, which may approve
// it. A System 2 scoop allowed only `open --view` drove playwright-cli
// itself for 100+ steps that way (2026-10-01). So webrunner never grants a
// command: screenshots go in as images, and escalation is switched off.
// A slicc without those options gets no images and a warning.
let agentCaps = null;
async function agentCapabilities() {
  if (agentCaps) return agentCaps;
  const help = await exec.spawn(['agent', '--help']);
  const text = `${help.stdout || ''}${help.stderr || ''}`;
  agentCaps = {
    images: /--image\b/.test(text),
    noEscalate: /--no-escalate\b/.test(text),
    // slicc#3760: a short system prompt with only StructuredOutput, resumable
    // sessions, and per-call usage.
    minimal: /--minimal\b/.test(text),
    session: /--session\b/.test(text),
  };
  if (!agentCaps.noEscalate) {
    await say('warning: this slicc cannot stop an agent() scoop from escalating commands to the cone');
  }
  return agentCaps;
}

// The text of a type answer, or '' when it is missing or too long.
const textOf = (answer) => {
  const text = answer && typeof answer.text === 'string' ? answer.text.trim() : '';
  return text.length <= 2000 ? text : '';
};


function agentDecider(flags, model = flags.model || AGENT_MODEL_DEFAULT, thinking = 'off') {
  const useSession = onOff(flags['agent-session'], false);
  const runTag = `meep-${Date.now().toString(36)}`;
  const sessions = new Map(); // kind -> { n: generation, turns }
  // Token use of every call, when this slicc reports it.
  const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  // kind: 'decide' or 'review' share a resumed session of that kind with
  // --agent-session; anything else is a one-shot call.
  const ask = async (prompt, schema, images = [], kind = null) => {
    const caps = await agentCapabilities();
    status.phase = `an agent call (${model})`;
    const opts = {
      model,
      thinking,
      schema,
      cwd: '/tmp/meep',
      allowedCommands: 'true',
      readOnly: '/tmp/meep/',
      ...(caps.noEscalate ? { escalate: false } : {}),
      ...(caps.images && images.length ? { images } : {}),
      ...(caps.minimal ? { minimal: true } : {}),
      ...(caps.session ? { envelope: true } : {}),
    };
    if (caps.session && useSession && kind) {
      const s = sessions.get(kind) || { n: 0, turns: 0 };
      if (s.turns >= SESSION_TURNS) Object.assign(s, { n: s.n + 1, turns: 0 });
      s.turns += 1;
      sessions.set(kind, s);
      opts.session = `${runTag}-${kind}-${s.n}`;
    }
    const reply = await agent(prompt, opts);
    if (!caps.session || !reply || typeof reply !== 'object' || !('output' in reply)) return reply;
    if (reply.usage) {
      usage.calls += 1;
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) {
        usage[k] += Number(reply.usage[k]) || 0;
      }
    }
    return reply.output;
  };
  // Whether the next call of this kind continues a session (the prompt can skip the instructions).
  const continues = (kind) => {
    const s = sessions.get(kind);
    return Boolean(useSession && s && s.turns > 0 && s.turns < SESSION_TURNS);
  };
  // Images only go along when this slicc can attach them.
  const attachable = async (images) => ((await agentCapabilities()).images ? images.filter(Boolean) : []);
  return {
    name: `agent ${model}`,
    takesHint: true,
    usage,
    // System 2: the trail, the plan and the notes, one or two screenshots,
    // and every control in view. It answers with an action and an
    // assessment, and may rewrite the plan, change notes and set values.
    async deliberate(ctx, menu) {
      const images = await attachable(ctx.imagePaths || []);
      const caps = await agentCapabilities();
      const session = Boolean(caps.session && useSession);
      const schema = page.system2Schema(menu, { stable: session });
      let prompt = page.system2Prompt({ ...ctx, menu, imageCount: images.length, continued: continues('decide') });
      let answer = await ask(prompt, schema, images, 'decide');
      let action;
      try {
        action = page.pickAction(menu, answer && answer.action);
      } catch (err) {
        // Without the enum (sessions), an id can miss the menu: ask once more.
        if (!session) throw err;
        prompt = `${err.message}. Choose an id from this menu:\n${menu.map((a) => `  ${a.id}  ${a.describe}`).join('\n')}`;
        answer = await ask(prompt, schema, [], 'decide');
        action = page.pickAction(menu, answer && answer.action);
      }
      // A type action with no text ended the run: "type:e2 came back without
      // text" on Wikipedia, eval round 37009340905 (2026-10-02). Ask once
      // more, saying so; then wait rather than fail.
      if (action.operation === 'TYPE_TEXT' && !action.text && !textOf(answer)) {
        prompt = `${prompt}\n\nYour last answer chose ${action.id} but gave no \`text\`. A type action needs the exact text in \`text\`; or choose another action.`;
        answer = await ask(prompt, schema, images, 'decide');
        action = page.pickAction(menu, answer && answer.action);
      }
      if (action.operation === 'TYPE_TEXT' && !action.text) {
        const text = textOf(answer);
        if (text) action = { ...action, text };
        else {
          await say(`         system 2 chose ${action.id} twice without text; waiting instead`);
          action = menu.find((a) => a.operation === 'WAIT') || action;
        }
      }
      return {
        action,
        prompt,
        answer,
        assessment: typeof answer.assessment === 'string' ? answer.assessment.trim().slice(0, 800) : '',
        // A hand-over sets the next steps; only a plan review rewrites the plan.
        next: page.cleanNext(answer.next_steps),
        noteAdd: answer.note_add,
        noteRemove: answer.note_remove,
        values: page.cleanValues(answer.values),
      };
    },
    // The plan review: no action, only a new plan, notes and values.
    async review(ctx) {
      const images = await attachable(ctx.imagePaths || []);
      const prompt = page.reviewPrompt({ ...ctx, imageCount: images.length });
      const answer = await ask(prompt, page.REVIEW_SCHEMA, images, 'review');
      return {
        prompt,
        answer,
        assessment: typeof answer.assessment === 'string' ? answer.assessment.trim().slice(0, 800) : '',
        plan: page.cleanList(answer.plan, page.MAX_PLAN),
        next: page.cleanNext(answer.next_steps),
        noteAdd: answer.note_add,
        noteRemove: answer.note_remove,
        values: page.cleanValues(answer.values),
      };
    },
    async plan(goal, state, imagePath) {
      const images = await attachable([imagePath]);
      const prompt = page.planPrompt(goal, state, images.length);
      const answer = await ask(prompt, page.PLAN_SCHEMA, images);
      return {
        prompt,
        answer,
        plan: page.cleanList(answer && answer.plan, page.MAX_PLAN) || [],
        notes: page.cleanList(answer && answer.notes, page.MAX_NOTES) || [],
      };
    },
    async decide(state, menu, hint, extra = {}) {
      const images = await attachable([extra.imagePath]);
      let prompt = page.agentPrompt(state, menu, hint, images.length);
      let answer = await ask(prompt, page.decisionSchema(menu), images);
      let action = page.pickAction(menu, answer && answer.action);
      // As in deliberate: a type action without text gets one more ask,
      // then the step waits instead of ending the run.
      if (action.operation === 'TYPE_TEXT' && !action.text && !textOf(answer)) {
        prompt = `${prompt}\n\nYour last answer chose ${action.id} but gave no \`text\`. A type action needs the exact text in \`text\`; or choose another action.`;
        answer = await ask(prompt, page.decisionSchema(menu), images);
        action = page.pickAction(menu, answer && answer.action);
      }
      const trail = { prompt, answer };
      if (action.operation !== 'TYPE_TEXT' || action.text) return { action, ...trail };
      if (textOf(answer)) return { action: { ...action, text: textOf(answer) }, ...trail };
      await say(`         the agent chose ${action.id} twice without text; waiting instead`);
      return { action: menu.find((a) => a.operation === 'WAIT') || action, ...trail };
    },
    async finished(state) {
      const answer = await ask(page.finishedPrompt(state), page.FINISHED_SCHEMA);
      return { finished: Boolean(answer && answer.finished === true), answer };
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
  // The child does the whole run. It gets this run's deadline, a little
  // earlier, so its own time limit fires first and names its real phase.
  // Before, the parent fired at 540 s "during installing the kev runtime"
  // while the child was already playing, and the child ran on (diag round
  // 2 on the hosted L4 leader, 2026-10-02).
  status.phase = 'the run after kev prepare (its log lines are above)';
  await host.reexec(exec, READY, {
    env: status.deadline ? { [DEADLINE_ENV]: String(status.deadline - CHILD_MARGIN_MS) } : {},
    onStart: (handle) => {
      status.child = handle;
    },
  });
}

// ── remote System 1: Cloudflare's Clef decision models ──────────────
// Clef (Qwen 3.8-27B) and Clef-flash (Qwen 3.5-9B) on Workers AI answer
// the same System One request as kev ({ state, questions }) and take
// images as data URLs in `images` (probed 2026-10-02: `image` is
// rejected). The token is a slicc secret scoped to api.cloudflare.com:
// webrunner sends its masked value and the fetch proxy swaps in the real
// one, so the token never reaches this script, its log or its trace.
const REMOTE_MODELS = { clef: '@cf/cloudflare/clef', 'clef-flash': '@cf/cloudflare/clef-flash' };

async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const got = await exec.spawn(['secret', 'get', 'CLOUDFLARE_API_TOKEN']);
  const m = /CLOUDFLARE_API_TOKEN=(\S+)/.exec(got.stdout || '');
  return m ? m[1] : '';
}

async function remoteDecider(flags, size) {
  const account = flags['cf-account'] || process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = await cloudflareToken();
  if (!account || !token) {
    cli.die(
      `--model ${size} runs on Cloudflare Workers AI. Store the API token as a secret (secret set CLOUDFLARE_API_TOKEN <token> --domain api.cloudflare.com) and pass --cf-account <account id> or set CLOUDFLARE_ACCOUNT_ID.`,
      { prefix: 'webrunner' }
    );
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${REMOTE_MODELS[size]}`;
  const ask = async (body, imagePath) => {
    const payload = { model: size, ...body };
    if (imagePath) {
      const jpeg = Buffer.from(await vision.toJpeg(await fs.readFileBinary(imagePath)));
      payload.images = [`data:image/jpeg;base64,${jpeg.toString('base64')}`];
    }
    status.phase = `a ${size} decision`;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (res.ok && data && data.success) return data.result;
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Workers AI refused the token (HTTP ${res.status}); check the CLOUDFLARE_API_TOKEN secret and the account id`);
      }
      const why = data && data.errors && data.errors[0] ? data.errors[0].message : text.slice(0, 200);
      throw new Error(`Workers AI ${size}: HTTP ${res.status}: ${why}`);
    }
  };
  await say(`System 1: ${size} on Workers AI`);
  return {
    name: `${size} (Workers AI)`,
    loadMs: 0,
    async decide(state, menu, extra = {}) {
      const img = extra.imagePath || null;
      const response = await ask({ state, questions: { action: page.menuQuestion(menu) } }, img);
      const answer = response.answers.action;
      const probabilities = answer.probabilities || {};
      const top = Object.entries(probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, p]) => `${id}=${p}`)
        .join(' ');
      let action = page.pickAction(menu, answer.choice);
      let textConfidence;
      if (action.operation === 'TYPE_TEXT' && !action.text && action.candidates) {
        const second = await ask({ state, questions: { text: page.textQuestion(action) } }, img);
        const pick = second.answers.text;
        action = { ...action, text: action.candidates[Number(pick.choice.slice(1))] };
        textConfidence = pick.confidence;
      }
      return { action, confidence: answer.confidence, textConfidence, top, probabilities };
    },
    async finished(state) {
      const response = await ask({
        state,
        questions: { finished: { type: 'noul', instructions: 'Does this page show every part of the goal finished?' } },
      });
      const p = response.answers.finished.noul;
      return { finished: p >= 0.5, answer: { noul: p } };
    },
  };
}

async function kevDecider(flags) {
  const size = flags.model || (onOff(flags.vision, false) ? '4b-vision' : '9b');
  if (REMOTE_MODELS[size]) return remoteDecider(flags, size);
  if (onOff(flags.vision, false) && !size.endsWith('-vision')) {
    cli.die('--vision needs a vision model: --model 4b-vision or 0.8b-vision', { prefix: 'webrunner' });
  }
  if (!kevRuntime.MODELS[size]) {
    cli.die(`--model must be one of ${Object.keys(kevRuntime.MODELS).join(', ')} with --decider kev`, {
      prefix: 'webrunner',
    });
  }
  if (!flags.from) {
    const status = await kevRuntime.weightsStatus(fs, size);
    if (status.missing.length) cli.die(kevRuntime.missingWeightsMessage(status), { prefix: 'webrunner' });
  }
  status.phase = 'installing the kev runtime';
  await ensureKevRuntime();
  status.phase = `loading kev ${size}`;
  await say(`loading kev ${size}`);
  const loadStarted = Date.now();
  const model = await kevRuntime.openModel(fs, exec, {
    model: size,
    from: flags.from || null,
    requireGpu: onOff(flags['require-gpu'], false),
    log: (line) => {
      if (/phase (ready|session)|runtime|adapter|failed/.test(line)) say(line);
    },
    // Named here, in the entry script: see kev-runtime.js loadKev.
    requireBundle: () => require('/shared/cache/kev/bundle.cjs'),
  });
  const loadMs = Date.now() - loadStarted;
  await say('kev loaded');
  return {
    name: `kev ${size}`,
    loadMs,
    async decide(state, menu, extra = {}) {
      status.phase = `a kev ${size} decision`;
      const response = await model.systemOne({
        state,
        ...(extra.image ? { image: extra.image } : {}),
        questions: { action: page.menuQuestion(menu) },
      });
      const answer = response.answers.action;
      const probabilities = answer.probabilities || {};
      const top = Object.entries(probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, p]) => `${id}=${p}`)
        .join(' ');
      let action = page.pickAction(menu, answer.choice);
      let textConfidence;
      if (action.operation === 'TYPE_TEXT' && !action.text && action.candidates) {
        // Same state, so kev.js reuses its cache: only the text options run.
        const second = await model.systemOne({
          state,
          ...(extra.image ? { image: extra.image } : {}),
          questions: { text: page.textQuestion(action) },
        });
        const pick = second.answers.text;
        action = { ...action, text: action.candidates[Number(pick.choice.slice(1))] };
        textConfidence = pick.confidence;
      }
      return { action, confidence: answer.confidence, textConfidence, top, probabilities };
    },
    async finished(state) {
      status.phase = `a kev ${size} DONE check`;
      const response = await model.systemOne({
        state,
        questions: {
          finished: { type: 'noul', instructions: 'Does this page show every part of the goal finished?' },
        },
      });
      const p = response.answers.finished.noul;
      return { finished: p >= 0.5, answer: { noul: p } };
    },
  };
}

// kev alone cannot invent text: a field without a goal value is a dead end.
function kevOnly(fast) {
  return {
    ...fast,
    async decide(state, menu, extra) {
      const first = await fast.decide(state, menu, extra);
      if (first.action.operation === 'TYPE_TEXT' && !first.action.text) {
        throw new Error('kev picked a field, but the goal has no value for it. Quote the text in --goal.');
      }
      return first;
    },
  };
}

// System 1 decides; when it shrugs (picks SHRUG, is unsure, or picked a
// field it has no text for), System 2 decides on the same state and menu,
// told what System 1 was considering. DONE is checked by System 1 and,
// when that is unsure, by System 2.
function hybridDecider(fast, slow, threshold) {
  return {
    name: `${fast.name} + ${slow.name}`,
    loadMs: fast.loadMs,
    shrugs: true,
    plans: true,
    usage: slow.usage,
    plan: (goal, state, imagePath) => slow.plan(goal, state, imagePath),
    review: (ctx) => slow.review(ctx),
    async decide(state, menu, extra = {}) {
      const first = await fast.decide(state, menu, extra);
      const reason = page.shrugReason(first, threshold, { avoid: extra.avoid });
      const system1 = {
        action: first.action.id,
        confidence: first.confidence,
        probabilities: first.probabilities,
        shrug: reason || null,
      };
      // A random audit: System 1 was sure, System 2 reviews the step anyway.
      // A rut audit: kev, sure of itself, is repeating one action again.
      const rut = !reason && !extra.oversight ? page.rutAudit(extra.rut, first.action.describe) : null;
      if (!reason && (extra.oversight || rut)) {
        system1.oversight = extra.oversight || rut;
        // System 2 chooses from every control in view, not System 1's top ones.
        const rest = (extra.menuS2 || menu).filter((action) => action.operation !== 'SHRUG');
        const slowStarted = Date.now();
        const second = await slow.deliberate(
          {
            ...(extra.context || {}),
            state,
            hint: page.oversightHint(first, system1.oversight.reason, menu, Boolean(system1.oversight.rut)),
            imagePaths: extra.imagePaths,
          },
          rest
        );
        return {
          ...second,
          system: slow.name,
          system1,
          system2Ms: Date.now() - slowStarted,
          top: `${first.top}  → audit (${system1.oversight.reason}, p=${system1.oversight.chance})`,
        };
      }
      if (!reason) return { ...first, system: fast.name, system1 };
      const slowStarted = Date.now();
      const rest = (extra.menuS2 || menu).filter((action) => action.operation !== 'SHRUG');
      const second = await slow.deliberate(
        { ...(extra.context || {}), state, hint: page.shrugHint(first, reason, menu), imagePaths: extra.imagePaths },
        rest
      );
      return {
        ...second,
        system: slow.name,
        system1,
        system2Ms: Date.now() - slowStarted,
        top: `${first.top}  → shrug (${reason})`,
      };
    },
    async finished(state) {
      const first = await fast.finished(state);
      const p = first.answer && typeof first.answer.noul === 'number' ? first.answer.noul : null;
      // A DONE verdict between 0.25 and 0.75 is a coin toss: ask System 2.
      if (p == null || Math.abs(p - 0.5) >= 0.25) return { ...first, system: fast.name };
      const second = await slow.finished(state);
      return { ...second, system: slow.name, system1: first.answer };
    },
  };
}

async function makeDecider(flags) {
  const name = flags.decider || 'kev';
  if (name === 'agent') return agentDecider(flags);
  if (name === 'kev') return kevOnly(await kevDecider(flags));
  if (name === 'system2') {
    // System 2 on every step, no kev: the same loop, plan, trail and notes
    // as hybrid, so the two differ only in kev. Answers "is kev a helper?".
    const slow = agentDecider(
      flags,
      flags.model || SYSTEM2_MODEL_DEFAULT,
      THINKING_LEVELS.includes(flags['agent-thinking']) ? flags['agent-thinking'] : SYSTEM2_THINKING_DEFAULT
    );
    return {
      name: `system2 ${slow.name.replace(/^agent /, '')}`,
      plans: true,
      usage: slow.usage,
      plan: (goal, state, imagePath) => slow.plan(goal, state, imagePath),
      decide: (state, menu, extra = {}) =>
        slow.deliberate(
          { ...(extra.context || {}), state, imagePaths: extra.imagePaths },
          extra.menuS2 || menu
        ),
      finished: (state) => slow.finished(state),
    };
  }
  if (name === 'hybrid') {
    const parsed = Number.parseFloat(flags.shrug);
    const threshold = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : SHRUG_DEFAULT;
    return hybridDecider(
      await kevDecider(flags),
      agentDecider(
        flags,
        flags['agent-model'] || SYSTEM2_MODEL_DEFAULT,
        THINKING_LEVELS.includes(flags['agent-thinking']) ? flags['agent-thinking'] : SYSTEM2_THINKING_DEFAULT
      ),
      threshold
    );
  }
  return cli.die('--decider is kev, agent, hybrid, or system2', { prefix: 'webrunner' });
}

// ── observe ───────────────────────────────────────────────────────────

// FNV-1a over the screenshot's bytes: equal pixels encode to equal PNGs.
function hashBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${data.length}:${h.toString(16)}`;
}

const VIEWPORT_JS =
  'JSON.stringify({ width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight })';

// What the snapshot cannot tell the decider, read in the page each turn:
// clickable divs and disambiguators for repeated controls (page-scan.js).
const PAGE_SCAN_JS = `(${pageScan.scan.toString()})()`;

// A synthetic button (page.promoteClickable) has no ref: click the element
// under its box centre.
function clickAt(box) {
  const x = Math.round(box[0] + box[2] / 2);
  const y = Math.round(box[1] + box[3] / 2);
  return `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return 'missing';
    el.click();
    return 'ok';
  })()`;
}

function parseScan(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim());
    const found = typeof value === 'string' ? JSON.parse(value) : value;
    return {
      clickable: Array.isArray(found && found.clickable) ? found.clickable : [],
      disambiguation: Array.isArray(found && found.disambiguation) ? found.disambiguation : [],
    };
  } catch {
    return { clickable: [], disambiguation: [] };
  }
}

function parseViewport(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim());
    const viewport = typeof value === 'string' ? JSON.parse(value) : value;
    return viewport && viewport.height > 0 ? viewport : null;
  } catch {
    return null;
  }
}

/**
 * One look at the tab. → { shot, raw, viewport, diff, screenshot, commands, ms }
 * `prev` is the last cycle's observation: the diff against it is the
 * feedback on the last action.
 */
async function observe(tab, prev, opts) {
  const started = Date.now();
  const commands = [];
  const argv = ['playwright-cli', 'snapshot', `--tab=${tab}`];
  if (opts.viewport) argv.push('--boxes');
  const raw = await sh(argv, commands);
  const shot = page.parseSnapshot(raw);
  let viewport = null;
  if (opts.viewport) {
    const evaluated = await run(['playwright-cli', 'eval', `--tab=${tab}`, VIEWPORT_JS], commands);
    viewport = evaluated.exitCode === 0 ? parseViewport(evaluated.stdout) : null;
  }
  shot.viewport = viewport;
  let shotWithClicks = shot;
  let disambiguation = [];
  if (opts.viewport) {
    const found = await run(['playwright-cli', 'eval', `--tab=${tab}`, PAGE_SCAN_JS], commands);
    if (found.exitCode === 0) {
      const scanned = parseScan(found.stdout);
      shotWithClicks = page.promoteClickable(shot, scanned.clickable, viewport);
      disambiguation = scanned.disambiguation;
    }
  }
  let screenshot = null;
  if (opts.trace && opts.shots && opts.name) {
    const name = `${opts.name}.png`;
    const result = await run(
      ['playwright-cli', 'screenshot', `--tab=${tab}`, `--filename=${opts.trace.path(name)}`],
      commands
    );
    if (result.exitCode === 0) screenshot = name;
  }
  return {
    shot: shotWithClicks,
    disambiguation,
    raw,
    viewport,
    diff: page.diffShots(prev && prev.shot, shotWithClicks),
    screenshot,
    commands,
    ms: Date.now() - started,
  };
}

// playwright-cli open returns while the tab still shows about:blank, and a
// step spent there is a model call with nothing to choose (seen 2026-09-23).
async function waitForPage(tab) {
  for (let i = 0; i < 20; i++) {
    const shot = page.parseSnapshot(await sh(['playwright-cli', 'snapshot', `--tab=${tab}`]));
    if (shot.url && shot.url !== 'about:blank' && shot.elements.length) return;
    await sh(['sleep', '0.5']);
  }
}

function expected(obs, flags) {
  return page.checkExpect(obs, flags.expect, flags['expect-url']);
}

// ── act ───────────────────────────────────────────────────────────────

async function openTab(url) {
  const stdout = await sh(['playwright-cli', 'open', url, '--foreground']);
  const match = /targetId:\s*([^\]\s]+)/.exec(stdout);
  if (match) return match[1];
  throw new Error(`playwright-cli open did not report a tab: ${stdout.slice(0, 240)}`);
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

// A rich-text editor (contenteditable, The Password Game) has no select():
// selectAll through execCommand, so typing replaces the text, not appends.
const SELECT_FOCUSED = `(() => {
  const el = document.activeElement;
  if (el && typeof el.select === 'function') el.select();
  else if (el && el.isContentEditable) document.execCommand('selectAll');
  return 'ok';
})()`;

/** Apply one action. Every playwright-cli call lands in `commands`. */
async function act(tab, action, viewport, commands) {
  if (action.operation === 'WAIT') {
    await sh(['sleep', '0.5'], commands);
    return;
  }
  if (action.operation === 'SCROLL') {
    // The wheel scrolls whatever is under the mouse, so put the mouse in the
    // middle of the viewport first: at 0,0 it sits on a sticky header.
    const width = viewport ? viewport.width : 1280;
    const height = viewport ? viewport.height : 800;
    const dy = Math.round(height * 0.8) * (action.direction === 'up' ? -1 : 1);
    await sh(['playwright-cli', 'mousemove', `--tab=${tab}`, String(Math.round(width / 2)), String(Math.round(height / 2))], commands);
    await sh(['playwright-cli', 'mousewheel', `--tab=${tab}`, '0', String(dy)], commands);
    return;
  }
  if (action.element.synthetic) {
    const clicked = await sh(['playwright-cli', 'eval', `--tab=${tab}`, clickAt(action.element.box)], commands);
    if (!clicked.includes('ok')) throw new Error(`nothing to click at "${action.element.label}"`);
    return;
  }
  const ref = action.element.token;
  const keystrokes = action.operation === 'TYPE_TEXT';
  // A ref of a repeated name reaches only the first control of that name
  // (page-scan.js), so those are clicked by their place in the page.
  if (Number.isInteger(action.element.nth)) {
    const pick = JSON.stringify({ name: action.element.label, nth: action.element.nth });
    const picked = await sh(['playwright-cli', 'eval', `--tab=${tab}`, `(${pageScan.scan.toString()})(${pick})`], commands);
    if (picked.includes('ok')) {
      if (!keystrokes) return;
      await sh(['sleep', '0.3'], commands);
      await sh(['playwright-cli', 'eval', `--tab=${tab}`, SELECT_FOCUSED], commands);
      await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text], commands);
      return;
    }
  }
  // Text goes in as keystrokes. `fill` sets the value, but Google Flights'
  // "Where to?" then opens an empty overlay with no suggestions, and its
  // Return date field drops the value (both seen 2026-09-23). Click the
  // field, select what is there, and type.
  const result = await run(['playwright-cli', 'click', `--tab=${tab}`, ref], commands);
  if (result.exitCode === 0) {
    if (!keystrokes) return;
    await sh(['sleep', '0.3'], commands);
    await sh(['playwright-cli', 'eval', `--tab=${tab}`, SELECT_FOCUSED], commands);
    await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text], commands);
    return;
  }
  const detail = `${result.stderr || ''}${result.stdout || ''}`;
  if (!/Element not found|Unknown ref/.test(detail)) {
    throw new Error(`playwright-cli click ${ref} failed: ${detail.trim().slice(0, 300)}`);
  }
  await say(`         ${ref} has no node id; focusing "${action.element.label.trim()}" by name`);
  const focused = await sh(
    ['playwright-cli', 'eval', `--tab=${tab}`, focusByName(action.element, action.operation === 'CLICK')],
    commands
  );
  if (!focused.includes('ok')) throw new Error(`no visible control named "${action.element.label.trim()}"`);
  if (action.operation === 'TYPE_TEXT') {
    await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text], commands);
  }
}

// ── loop ──────────────────────────────────────────────────────────────

// What the debug page needs of an element: enough to draw and name it.
function slim(element, viewport) {
  const where = page.place(element, viewport);
  const out = { token: element.token, role: element.role, label: element.label, kind: element.kind };
  if (element.value) out.value = element.value;
  if (element.box) out.box = element.box;
  if (element.region) out.region = element.region;
  if (Number.isInteger(element.nth)) out.nth = element.nth;
  if (where !== 'unknown') out.place = where;
  return out;
}

function slimAction(action) {
  const out = { id: action.id, operation: action.operation, describe: action.describe };
  if (action.element) out.token = action.element.token;
  if (action.text) out.text = action.text;
  return out;
}

async function observeRecord(trace, obs, name) {
  return {
    url: obs.shot.url,
    title: obs.shot.title,
    viewport: obs.viewport,
    screenshot: obs.screenshot,
    snapshot: await trace.file(`${name}.snapshot.txt`, obs.raw),
    elements: obs.shot.elements.map((element) => slim(element, obs.viewport)),
    texts: obs.shot.texts.slice(0, 200),
    // The page text as the decider would read it. A terminal observation
    // (check passed, stalled, out of steps) has no orient, and the eval's
    // judge and game metrics read the final page from here.
    pageText: page.pageTextLines(obs.shot, obs.viewport).join('\n'),
    ms: obs.ms,
    commands: obs.commands,
  };
}

async function runGoal(flags) {
  if (!flags.url) cli.die('--url is required', { prefix: 'webrunner' });
  if (!flags.goal) cli.die('--goal is required', { prefix: 'webrunner' });
  let hostname = '';
  try {
    hostname = new URL(flags.url).hostname;
  } catch {
    cli.die(`--url is not a URL: ${flags.url}`, { prefix: 'webrunner' });
  }
  await fs.mkdir('/tmp/meep', { recursive: true });
  await fs.writeFile(LOG_PATH, '');
  const parsedMax = parseInt(flags['max-steps'], 10);
  const maxSteps = Number.isFinite(parsedMax) ? Math.min(Math.max(parsedMax, 1), MAX_STEPS_CAP) : MAX_STEPS_DEFAULT;
  const hasCheck = Boolean(flags.expect || flags['expect-url']);
  // A child re-run after kev prepare inherits what is left of the parent's limit.
  const ownLimit = numberFlag(flags['time-limit'], 0, 0, TIME_LIMIT_CAP);
  const inherited = Number(process.env[DEADLINE_ENV]);
  const left = inherited > 0 ? Math.max(1, Math.floor((inherited - Date.now()) / 1000)) : 0;
  const timeLimit = left && (!ownLimit || left < ownLimit) ? left : ownLimit;
  const opts = {
    viewport: onOff(flags.viewport, true),
    shots: onOff(flags.shots, true),
    vision: onOff(flags.vision, false),
    // One type option per field and the text as a second question: kev's
    // time grows with the menu (54 options took 5-6 s per step on Google
    // Flights, 21 took 2 s; 2026-10-01). The agent writes text itself.
    factorText: !AGENT_WRITES_TEXT.has(flags.decider) && onOff(flags['factor-text'], true),
    pageText: onOff(flags['page-text'], true),
    plan: onOff(flags.plan, true),
    oversight: flags.decider === 'hybrid' ? numberFlag(flags.oversight, OVERSIGHT_DEFAULT, 0, 1) : 0,
    seed: Number.isFinite(Number.parseInt(flags.seed, 10))
      ? Number.parseInt(flags.seed, 10)
      : Math.floor(Math.random() * 2 ** 31),
    window: parseWindow(flags.window, onOff(flags.vision, false)),
  };
  if (opts.vision && !opts.shots) cli.die('--vision needs the screenshot: drop --shots off', { prefix: 'webrunner' });
  const started = Date.now();
  if (timeLimit) status.deadline = started + timeLimit * 1000;
  // The agent writes the text for a type action itself; kev can only pick
  // values that the goal spells out (and hybrid shrugs to the agent for the rest).
  const candidates = AGENT_WRITES_TEXT.has(flags.decider) ? [] : page.textCandidates(flags.goal);
  const result = {
    ok: false,
    reason: '',
    decider: flags.decider || 'kev',
    steps: 0,
    seconds: 0,
    loadSeconds: null,
    decideSeconds: 0,
    url: flags.url,
  };
  let trace = null;
  let ended = false;
  const finish = async (ok, reason, url) => {
    if (ended) return result;
    ended = true;
    result.ok = ok;
    result.reason = reason;
    if (url) result.url = url;
    result.seconds = (Date.now() - started) / 1000;
    result.decideSeconds = Math.round(result.decideSeconds * 10) / 10;
    if (trace) await trace.end(result);
    return result;
  };

  const work = (async () => {
    status.phase = 'loading the decider';
    const decider = await makeDecider(flags);
    result.decider = decider.name;
    // Agent token use and cost, when this slicc reports it per call (slicc#3760).
    // (Left out when nothing was reported: a slicc without it read as 0 calls.)
    if (decider.usage) {
      Object.defineProperty(result, 'agentUsage', {
        enumerable: true,
        configurable: true,
        get: () => (decider.usage.calls ? decider.usage : undefined),
      });
    }
    result.loadSeconds = decider.loadMs == null ? null : decider.loadMs / 1000;
    trace = await traceLib.openTrace(fs, { label: flags.label || hostname });
    result.run = trace.id;
    await trace.start({
      goal: flags.goal,
      url: flags.url,
      decider: decider.name,
      loadSeconds: result.loadSeconds,
      check: { expect: flags.expect || null, expectUrl: flags['expect-url'] || null },
      maxSteps,
      timeLimit: timeLimit || null,
      candidates,
      viewport: opts.viewport,
      vision: opts.vision,
      oversight: opts.oversight,
      seed: opts.seed,
    });
    await say(`run ${trace.id}`);
    // A run that throws still ends its trace, so the debug page says why.
    try {
      return await cycles(flags, { opts, decider, trace, result, finish, candidates, hasCheck, maxSteps });
    } catch (err) {
      if (err && err.name === 'NodeExitError') throw err;
      if (status.stopped) return result;
      result.reason = `error: ${err.message || err}`;
      result.seconds = (Date.now() - started) / 1000;
      ended = true;
      await trace.end(result);
      // main prints it with --json: the eval reads the run id from it.
      if (err && typeof err === 'object') err.result = result;
      throw err;
    }
  })();
  if (!timeLimit) return work;

  // The time limit covers everything, loading kev included. A step that
  // never returns (a kev load or decision, an agent call) cannot end the
  // run itself; the limit does, with the usual result and the place it
  // stuck. Hosted runs that hit the harness's own timeout left nothing.
  const EXPIRED = Symbol('expired');
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, status.deadline - Date.now()));
  });
  const first = await Promise.race([work, expired]);
  clearTimeout(timer);
  if (first !== EXPIRED) return first;
  status.stopped = true;
  work.catch(() => {});
  if (status.child) {
    try {
      status.child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  const reason = `time limit of ${timeLimit} s reached during ${stuckAt()}`;
  await say(reason);
  return finish(false, reason);
}

async function cycles(flags, run) {
  const { opts, decider, trace, result, finish, candidates, hasCheck, maxSteps } = run;
  status.phase = 'opening the tab';
  const tab = await openTab(flags.url);
  await say(`tab ${tab} ${flags.url}`);
  // Size the browser, not the image: with --vision the viewport is the
  // vision input (1024 x 576 = kev.js's 589,824-pixel cap, multiples of 32),
  // and resize sets the device scale to 1, so the screenshot needs no
  // scaling. At the default size a 1200 x 1279 viewport at DPR 2 came out
  // 2400 x 2558 and was shrunk 3.2x, too small for kev to read status text.
  if (opts.window) {
    await sh(['playwright-cli', 'resize', String(opts.window.width), String(opts.window.height), `--tab=${tab}`]);
    await say(`window ${opts.window.width}x${opts.window.height}`);
  }
  await waitForPage(tab);
  const history = [];
  // What System 2 reads and writes: its plan and notes (System 1 sees them
  // in its state) and the trail of recent steps with what each one changed.
  // values: texts System 2 left for System 1 to type.
  // planHistory: every plan with the step and who wrote it.
  // plan: the strategy (the original plan, plan reviews); next: System 2's
  // next steps for System 1, replaced by every hand-over.
  const memory = { plan: [], next: [], notes: [], values: [], trail: [], planHistory: [] };
  const remembered = () => ({ plan: memory.plan, next: memory.next, notes: memory.notes, values: memory.values });
  const setPlan = (plan, step, by) => {
    memory.plan = plan;
    memory.planHistory.push({ step, by, plan });
    if (memory.planHistory.length > 12) memory.planHistory.shift();
  };
  const planContext = () => {
    const last = memory.planHistory[memory.planHistory.length - 1];
    return {
      planFrom: last ? `written at step ${last.step} by ${last.by}` : '',
      planHistory: memory.planHistory,
    };
  };
  // The marked screenshot of each step, newest last, for plan reviews.
  const shots = [];
  // System 2's load: per System 1 decision, did it hand over (a shrug)?
  // Random audits are our choice, not System 1's, and do not count.
  const asked = [];
  let lastReview = -Infinity;
  let prevImagePath = null;
  let prevPixels = '';
  // Oversight: each turn's change magnitude, and the seeded audit roll.
  const magnitudes = [];
  const roll = page.seededRandom(opts.seed);
  // System 1 stuck on one or two actions (see page.trackRut), and per
  // pattern the steps before its next audit.
  let rut = null;
  const rutLimits = new Map();
  let prev = null;
  let previousLabels = null;
  let stalls = 0;
  const seenPages = [];
  let pendingDone = false;
  for (let step = 1; step <= maxSteps; step++) {
    if (status.stopped) return result;
    const name = `step-${String(step).padStart(2, '0')}`;
    const record = { step };
    status.step = step;
    status.phase = 'observe';

    // Observe. After the first cycle this is the feedback on the last action.
    const obs = await observe(tab, prev, { ...opts, trace, name });
    record.observe = await observeRecord(trace, obs, name);
    record.diff = obs.diff;
    // No progress is the same page as last time, or a page from a few
    // cycles back: actions that undo each other (a toggle) are a stall too.
    // The snapshot cannot see a canvas: buying food in Armchair Bike Touring
    // changed only the drawn status panel, and three purchases read as a
    // stall (2026-10-01). The screenshot's bytes count too.
    const pixels = obs.screenshot ? hashBytes(await fs.readFileBinary(trace.path(obs.screenshot))) : '';
    const pixelsChanged = Boolean(pixels && prevPixels && pixels !== prevPixels);
    const fp = `${page.fingerprint(obs.shot, obs.viewport)}\npixels=${pixels}`;
    const cycle = page.cycleBack(seenPages, fp);
    if (prev) {
      stalls = fp === seenPages[seenPages.length - 1] || cycle ? stalls + 1 : 0;
    }
    seenPages.push(fp);
    if (cycle) record.cycle = cycle;
    if (prev) {
      const m = page.changeMagnitude(obs.diff, obs.shot.elements.length);
      // A canvas change is a change, not calm.
      magnitudes.push(pixelsChanged ? Math.max(m, 0.1) : m);
    }
    // This observation is the outcome of the last step on the trail.
    const lastStep = memory.trail[memory.trail.length - 1];
    if (lastStep) {
      lastStep.changes = page.describeDiff(obs.diff);
      if (!lastStep.outcome) {
        if (cycle) lastStep.outcome = `the page went back to how it was ${cycle} steps ago`;
        else if (obs.diff && !lastStep.changes.length) lastStep.outcome = 'no visible effect';
      }
    }
    if (expected(obs, flags)) {
      record.outcome = 'check passed';
      await trace.step(record);
      await say(`step ${step}  verified: ${obs.shot.url}`);
      return finish(true, 'check passed', obs.shot.url);
    }
    if (stalls >= STALL_LIMIT) {
      record.outcome = 'stalled';
      await trace.step(record);
      return finish(false, `${STALL_LIMIT} actions in a row made no progress (page unchanged or back to an earlier one)`, obs.shot.url);
    }

    // Orient.
    status.phase = 'orient';
    const orientStarted = Date.now();
    const orientOpts = {
      goal: flags.goal,
      history,
      candidates,
      previousLabels,
      offerDone: !hasCheck,
      offerShrug: Boolean(decider.shrugs),
      factorText: opts.factorText,
      pageText: opts.pageText,
      cycle,
      pixelsChanged,
    };
    // The original plan: System 2 writes it from the goal and the first
    // observation, before System 1 takes a step.
    if (step === 1 && opts.plan && decider.plans) {
      const planStarted = Date.now();
      const first = page.orient(obs, orientOpts);
      const written = await decider.plan(
        flags.goal,
        first.state,
        opts.vision && obs.screenshot ? trace.path(obs.screenshot) : null
      );
      setPlan(written.plan, step, 'the original plan');
      memory.notes = written.notes;
      record.plan = { plan: written.plan, notes: written.notes, prompt: written.prompt, ms: Date.now() - planStarted };
      await say(`plan (${((Date.now() - planStarted) / 1000).toFixed(1)} s): ${written.plan.join(' | ')}`);
    }
    let ori = page.orient(obs, { ...orientOpts, ...remembered() });
    // A plan review when System 1 hands over most steps: System 2 takes no
    // action, rewrites the plan, notes and values, and System 1 decides on
    // the menu rebuilt from them (it may still shrug to System 2).
    // Not while a DONE waits for its confirmation: the run may be over.
    const due = decider.review && !pendingDone ? page.reviewDue(asked, step - lastReview) : null;
    if (due) {
      lastReview = step;
      const reviewStarted = Date.now();
      // The page now, then earlier steps' marked screenshots, newest first.
      const earlier = shots.slice(-(page.REVIEW_IMAGES - 1)).reverse();
      const reviewed = await decider.review({
        goal: flags.goal,
        ...remembered(),
        ...planContext(),
        trail: memory.trail,
        why: due.why,
        state: ori.state,
        menu: ori.menuS2,
        imagePaths: obs.screenshot ? [trace.path(obs.screenshot), ...earlier.map((e) => e.path)] : [],
        imageSteps: obs.screenshot ? [step, ...earlier.map((e) => e.step)] : [],
      });
      if (reviewed.plan && reviewed.plan.length) setPlan(reviewed.plan, step, 'a plan review');
      if (reviewed.next) memory.next = reviewed.next;
      const noted = page.applyNotes(memory.notes, reviewed.noteAdd, reviewed.noteRemove);
      memory.notes = noted.notes;
      if (reviewed.values) memory.values = reviewed.values;
      record.review = {
        why: due.why,
        load: due.load,
        assessment: reviewed.assessment,
        ...remembered(),
        notesAdded: noted.added,
        notesRemoved: noted.removed,
        prompt: reviewed.prompt,
        answer: reviewed.answer,
        ms: Date.now() - reviewStarted,
      };
      await say(`step ${step}  plan review (${due.why}, ${((Date.now() - reviewStarted) / 1000).toFixed(1)} s): ${reviewed.assessment}`);
      ori = page.orient(obs, { ...orientOpts, ...remembered() });
    }
    // With --vision the decider also sees the screenshot, each offered
    // control boxed and labelled with its ref.
    let image = null;
    if (opts.vision && obs.screenshot) {
      const marked = await vision.markedImage(
        await fs.readFileBinary(trace.path(obs.screenshot)),
        ori.menu,
        obs.viewport
      );
      image = marked.image;
      ori.state = `${ori.state}\nScreenshot: each offered control is boxed in red and labelled with its ref.`;
      await fs.writeFileBinary(trace.path(`${name}.vision.png`), marked.png);
      record.vision = {
        image: `${name}.vision.png`,
        width: image.width,
        height: image.height,
        marks: marked.marks.length,
        scaled: marked.scale < 1 ? marked.scale : undefined,
      };
    }
    record.orient = {
      state: ori.state,
      menu: ori.menu.map(slimAction),
      excluded: ori.excluded,
      scroll: ori.scroll,
      ms: Date.now() - orientStarted,
    };
    await fs.writeFile(
      `/tmp/meep/step-${step}.txt`,
      `${ori.state}\n\nMenu:\n${ori.menu.map((a) => `  ${a.id}  ${a.describe}`).join('\n')}\n`
    );

    // A DONE from the last cycle is confirmed on this observation.
    if (pendingDone) {
      pendingDone = false;
      const verdict = await decider.finished(ori.state);
      record.verify = verdict;
      if (verdict.finished) {
        record.outcome = 'done, confirmed on the next observation';
        await trace.step(record);
        await say(`step ${step}  done, confirmed on the next observation`);
        return finish(true, 'done, confirmed on the next observation', obs.shot.url);
      }
      await say(`step ${step}  DONE not confirmed`);
    }

    // Decide. Implicit guidance first: an observation that has one answer
    // (a consent wall, a menu with nothing but WAIT) skips the decider.
    const decideStarted = Date.now();
    const direct = page.directAction(obs.shot, obs.raw);
    const choices = ori.menu.filter((action) => action.operation !== 'SHRUG');
    let decision;
    if (direct) decision = { action: direct, system: 'direct' };
    else if (choices.length === 1) decision = { action: choices[0], system: 'direct' };
    else {
      const imagePath = record.vision ? trace.path(record.vision.image) : null;
      const extra = {
        image,
        imagePath,
        // For System 2: the page now. The page a step earlier cost ~800
        // tokens per hand-over and is in the trail's "what changed" already.
        imagePaths: [imagePath].filter(Boolean),
        menuS2: ori.menuS2,
        context: {
          goal: flags.goal,
          ...remembered(),
          ...planContext(),
          trail: memory.trail,
          load: decider.review ? page.system2Load(asked) : null,
        },
        oversight: (() => {
          if (!opts.oversight || !decider.shrugs) return null;
          const audit = page.oversightChance(opts.oversight, magnitudes);
          return roll() < audit.chance ? audit : null;
        })(),
        avoid: ori.avoid,
        rut,
      };
      const answer = decider.takesHint
        ? await decider.decide(ori.state, ori.menu, null, extra)
        : await decider.decide(ori.state, ori.menu, extra);
      decision = { system: decider.name, ...answer };
      if (decision.system1) asked.push(Boolean(decision.system1.shrug));
    }
    const decideMs = Date.now() - decideStarted;
    result.decideSeconds += decideMs / 1000;
    result.steps = step;
    const action = decision.action;
    record.decide = {
      system: decision.system,
      action: slimAction(action),
      confidence: decision.confidence == null ? null : decision.confidence,
      textConfidence: decision.textConfidence == null ? null : decision.textConfidence,
      probabilities: decision.probabilities || null,
      prompt: decision.prompt || null,
      answer: decision.answer || null,
      system1: decision.system1 || null,
      ms: decideMs,
    };
    // System 2 may rewrite the plan and add notes; System 1 reads them next.
    // System 2 may set the next steps, change notes and set values; the plan is the review's.
    if (decision.assessment != null || decision.next || decision.noteAdd || decision.noteRemove) {
      const nextChanged = Boolean(decision.next && decision.next.join('\n') !== memory.next.join('\n'));
      if (decision.next) memory.next = decision.next;
      const noted = page.applyNotes(memory.notes, decision.noteAdd, decision.noteRemove);
      memory.notes = noted.notes;
      if (decision.values) memory.values = decision.values;
      record.decide.system2 = {
        assessment: decision.assessment || '',
        nextChanged,
        notesAdded: noted.added,
        notesRemoved: noted.removed,
        ...remembered(),
      };
      if (decision.assessment) await say(`         system 2: ${decision.assessment}`);
    }
    const conf = decision.confidence == null ? '' : ` conf=${decision.confidence}`;
    const typed = action.operation === 'TYPE_TEXT' && !/^type "/.test(action.describe) ? ` "${action.text}"` : '';
    await say(`step ${step}  ${action.describe}${typed}  (${decideMs} ms${conf})`);
    if (decision.top) await say(`         top ${decision.top}`);

    // Act.
    if (status.stopped) return result;
    status.phase = 'act';
    const actStarted = Date.now();
    const commands = [];
    if (action.operation === 'DONE') {
      pendingDone = true;
    } else {
      // A failed action is feedback, not the end of the run: the control
      // may have changed between the snapshot and the click (a price that
      // finished loading renamed a Google Flights date button, 2026-10-01).
      // The next cycle observes again and the decider hears what failed.
      let failure = null;
      try {
        await act(tab, action, obs.viewport, commands);
      } catch (err) {
        if (err && err.name === 'NodeExitError') throw err;
        failure = err.message || String(err);
        await say(`         failed: ${failure}`);
      }
      record.actError = failure;
      history.push({
        operation: action.operation,
        text: action.text || null,
        direction: action.direction || null,
        label: action.element ? action.element.label : '',
        role: action.element ? action.element.role : '',
        failed: Boolean(failure),
      });
    }
    if (decision.system1) {
      const s1 = decision.system1;
      rut = page.trackRut(
        rut,
        {
          describe: action.describe,
          by: s1.oversight ? 'audit' : s1.shrug ? 'other' : 's1',
          audit: s1.oversight && s1.oversight.rut ? s1.oversight : null,
        },
        rutLimits
      );
    } else if (decision.system !== 'direct') rut = null;
    const shrugged = decision.system1 && (decision.system1.shrug || decision.system1.oversight);
    memory.trail.push({
      step,
      describe: action.describe,
      text: action.operation === 'TYPE_TEXT' && !/^type "/.test(action.describe) ? action.text : null,
      system: decision.system1 && decision.system1.oversight
        ? 'System 2 (audit)'
        : shrugged
          ? 'System 2'
          : decision.system1
            ? 'System 1'
            : decision.system,
      confidence: shrugged ? decision.system1.confidence : decision.confidence,
      shrug: decision.system1 && decision.system1.shrug ? decision.system1.shrug : null,
      outcome: record.actError ? `failed: ${record.actError}` : '',
    });
    if (memory.trail.length > page.REVIEW_TRAIL) memory.trail.shift();
    // Suggestion lists render a beat after the keystroke.
    await sh(['sleep', action.operation === 'TYPE_TEXT' ? '0.6' : '0.3'], commands);
    record.act = { commands, ms: Date.now() - actStarted, error: record.actError || undefined };
    delete record.actError;
    await trace.step(record);
    previousLabels = new Set(obs.shot.elements.map((element) => element.label));
    prevImagePath = record.vision ? trace.path(record.vision.image) : null;
    if (prevImagePath) {
      shots.push({ step, path: prevImagePath });
      if (shots.length > page.REVIEW_IMAGES) shots.shift();
    }
    prevPixels = pixels;
    prev = obs;
  }
  // The last action gets its feedback too: one more look for the check.
  if (prev) {
    const name = `step-${String(maxSteps + 1).padStart(2, '0')}`;
    const last = await observe(tab, prev, { ...opts, trace, name });
    const record = { step: maxSteps + 1, observe: await observeRecord(trace, last, name), diff: last.diff };
    if (expected(last, flags)) {
      record.outcome = 'check passed';
      await trace.step(record);
      await say(`step ${maxSteps + 1}  verified: ${last.shot.url}`);
      return finish(true, 'check passed', last.shot.url);
    }
    // A DONE on the last permitted step is confirmed here, as on any other.
    if (pendingDone) {
      const ori = page.orient(last, {
        goal: flags.goal,
        history,
        candidates,
        offerDone: !hasCheck,
        factorText: opts.factorText,
        pageText: opts.pageText,
        ...remembered(),
      });
      const verdict = await decider.finished(ori.state);
      record.verify = verdict;
      if (verdict.finished) {
        record.outcome = 'done, confirmed on the next observation';
        await trace.step(record);
        await say(`step ${maxSteps + 1}  done, confirmed on the next observation`);
        return finish(true, 'done, confirmed on the next observation', last.shot.url);
      }
      await say(`step ${maxSteps + 1}  DONE not confirmed`);
    }
    record.outcome = 'out of steps';
    await trace.step(record);
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
    console.log(`debug: webrunner debug ${result.run}`);
  }
  if (!result.ok) cli.die(`${result.reason} (webrunner debug ${result.run})`, { prefix: 'webrunner' });
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
      // Both dates, not only the city: a range picker can move the departure
      // and still land on a London search (seen 2026-10-01).
      expect: ['London', shortDate(7), shortDate(14)],
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
    label: name,
    url: local ? previewUrl(local[0]) : goal.url,
    decider: flags.decider,
    model: flags.model,
    from: flags.from,
    'agent-model': flags['agent-model'],
    'agent-thinking': flags['agent-thinking'],
    plan: flags.plan,
    oversight: flags.oversight,
    seed: flags.seed,
    shrug: flags.shrug,
    vision: flags.vision,
    'factor-text': flags['factor-text'],
    'page-text': flags['page-text'],
    window: flags.window,
    viewport: flags.viewport,
    shots: flags.shots,
  });
}

// The debug page reads the runs over /preview, so it is copied next to them.
async function debug(id) {
  if (!(await fs.exists(DEBUG_PAGE))) cli.die(`the debug page is missing (${DEBUG_PAGE})`, { prefix: 'webrunner' });
  await fs.mkdir(traceLib.RUNS, { recursive: true });
  await fs.writeFile(`${traceLib.RUNS}/debug.html`, await fs.readFile(DEBUG_PAGE));
  if (id && !(await fs.exists(`${traceLib.RUNS}/${id}/trace.jsonl`))) {
    cli.die(`no run ${id} under ${traceLib.RUNS}`, { prefix: 'webrunner' });
  }
  const url = `${previewUrl(`${traceLib.RUNS}/debug.html`)}${id ? `?run=${encodeURIComponent(id)}` : ''}`;
  await sh(['playwright-cli', 'open', url, '--foreground']);
  console.log(url);
}

async function main() {
  const parsed = host.normalizeFlags(process.argv.parseFlags(), ['json', 'help', 'h', 'vision', 'require-gpu']);
  const flags = parsed.flags;
  const sub = parsed.subcommand || '';
  if (flags.help || flags.h || !sub || sub === 'help') {
    cli.help(HELP);
    return;
  }
  try {
    if (sub === 'debug') {
      await debug(parsed.positional[1] || '');
      return;
    }
    let result;
    if (sub === 'run') result = await runGoal(flags);
    else if (sub === 'demo') result = await demo(parsed.positional[1] || '', flags);
    else cli.die(`unknown command: ${sub}`, { prefix: 'webrunner' });
    report(result, flags);
  } catch (err) {
    // process.exit, not cli.die's exit: only process.exit ends the script
    // while work is still pending (a step the time limit cut off, a kev or
    // agent call that never returns). cli.die, and a plain return, wait for
    // it, and the result printed before stays unseen (measured 2026-10-02).
    // Any other error too: cli.die alone left a crashed run hanging until
    // the eval killed it 13 minutes later (round 37009340905, 2026-10-02).
    if (err && err.name === 'NodeExitError') process.exit(err.code ?? 1);
    if (flags.json && err && err.result) cli.out(err.result);
    try {
      cli.die(err.message || String(err), { prefix: 'webrunner' });
    } catch (exit) {
      process.exit(exit && Number.isInteger(exit.code) ? exit.code : 1);
    }
  }
  if (sub === 'run' || sub === 'demo') process.exit(0);
}

await main();
