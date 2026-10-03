// The intent tool's engine, shared by the `intent` command and the eval
// arm's driver: observe a tab, ask System 1, act or answer (handle), and
// serve requests that other processes leave in /tmp/intent/q (serve). See
// intent.jsh for the command and intent.js for the decision model.
//
// createIntent({ exec, fs, browser, skill, requireBundle }) binds it to the
// sliccy modules of the entry script.

const page = require('./snapshot.js');
const pageScan = require('./page-scan.js');
const lib = require('./intent.js');
const system1 = require('./system1.js');
const { tabTools } = require('./tab.js');
const kevRuntime = require('./kev/kev-runtime.js');
const vision = require('./vision.js');

const DIR = '/tmp/intent';
const STATE = `${DIR}/state.json`;
const CALLS = `${DIR}/calls.jsonl`;
const QUEUE = `${DIR}/q`;
const ANSWERS = `${DIR}/a`;
const BEAT = `${DIR}/serve.json`;
// The daemon writes its heartbeat this often; a client trusts one this fresh.
const BEAT_MS = 2000;
const BEAT_FRESH_MS = 8000;
const POLL_MS = 100;

// The local default: see SKILL.md for the measurements behind it.
const DEFAULT_MODEL = '4b-vision';
const SHORTLIST_CONTROLS = 24;
const SHORTLIST_TEXT = 16;
const EVIDENCE = 6;
const WAIT_DEFAULT_S = 15;
const UNSURE_CANDIDATES = 5;
const LIST_MAX = 20;
const REGION_TEXTS = 6;
// RETRIEVE modes (intent serve --retrieve, an eval arm's variant): answer is
// one text, or the closest few when unsure; budget and lexical return the
// top texts by System 1 or by words until RETRIEVE_BUDGET characters.
const RETRIEVE_MODES = ['answer', 'budget', 'lexical'];
const RETRIEVE_BUDGET = 1200;

function createIntent({ exec, fs, browser, skill, requireBundle }) {
  class IntentError extends Error {
    constructor(message, exitCode = 1) {
      super(message);
      this.name = 'IntentError';
      this.exitCode = exitCode;
    }
  }

  // Page JavaScript goes through sliccy:browser: ~1 ms a call, where
  // `playwright-cli eval` costs ~750 ms (measured 2026-10-02). playwright-cli
  // stays for the snapshot (its refs) and for real input (click, type, press).
  const evalJs = (tab, expression) => browser.eval({ targetId: tab }, expression);
  const tools = tabTools({ exec, say: async () => {}, evalJs });
  const { run, js, observe, openTab, act } = tools;
  const STATES_JS = `(${pageScan.states.toString()})()`;

  // Enter as a browser does it. slicc's \`press Enter\` (and \`type --submit\`)
  // sends a CDP keyDown with only \`key\`, no text or keyCode, so a form is
  // never submitted (Wikipedia's search, 2026-10-02). In the page: keydown,
  // keypress and keyup on the focused element, then, when no handler took
  // it, the implicit submission of its form.
  const PRESS_ENTER_JS = `(() => {
    const el = document.activeElement || document.body;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    const press = down && el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: 13 }));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (down && press && el.form && el.tagName === 'INPUT') {
      if (el.form.requestSubmit) el.form.requestSubmit();
      else el.form.submit();
      return 'submitted';
    }
    return down && press ? 'pressed' : 'handled';
  })()`;

  async function pressKey(tab, key) {
    if (key === 'Enter') {
      const r = await js(tab, PRESS_ENTER_JS);
      if (r.exitCode === 0) return;
    }
    await pw(['press', key, `--tab=${tab}`]);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── state ─────────────────────────────────────────────────────────────

  async function readJson(path, fallback) {
    try {
      if (!(await fs.exists(path))) return fallback;
      return JSON.parse(String(await fs.readFile(path)));
    } catch {
      return fallback;
    }
  }

  async function writeJson(path, value) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, JSON.stringify(value));
  }

  async function logCall(entry) {
    try {
      await fs.mkdir(DIR, { recursive: true });
      const old = (await fs.exists(CALLS)) ? String(await fs.readFile(CALLS)) : '';
      await fs.writeFile(CALLS, `${old}${JSON.stringify(entry)}\n`);
    } catch {
      // The call log feeds evals; a call must not fail for it.
    }
  }

  // ── System 1 ──────────────────────────────────────────────────────────

  const models = new Map();

  // The Workers AI account: --cf-account or CLOUDFLARE_ACCOUNT_ID (remembered
  // in the skill's config), else the remembered one, else the only account
  // the token can list. A token scoped to Workers AI usually cannot list any.
  async function cfAccount(flags, token) {
    const config = (await skill.config()) || {};
    const given = flags['cf-account'] || process.env.CLOUDFLARE_ACCOUNT_ID;
    if (given) {
      if (!/^[a-f0-9]{32}$/.test(String(given))) throw new IntentError('--cf-account is a 32-character Cloudflare account id');
      if (config.cfAccount !== given) await skill.config({ cfAccount: String(given) });
      return String(given);
    }
    if (config.cfAccount) return config.cfAccount;
    const found = await system1.cloudflareAccount(fetch, token, null);
    if (found.error) {
      throw new IntentError(`${found.error}. Pass --cf-account <account id> once (it is remembered) or set CLOUDFLARE_ACCOUNT_ID.`);
    }
    await skill.config({ cfAccount: found.account });
    return found.account;
  }

  /**
   * A local kev bundle: a named one (`intent pull --model 4b-vision`) or the
   * bundle directory --from names (a fine-tuned export). A -vision bundle
   * also gets the marked screenshot on ACT.
   */
  async function kevModel(size, from, requireGpu = false) {
    if (!from && !kevRuntime.MODELS[size]) throw new IntentError(`--model is one of ${lib.MODELS.join(', ')}`);
    if (!from) {
      const status = await kevRuntime.weightsStatus(fs, size);
      if (status.missing.length) {
        throw new IntentError(`${kevRuntime.missingWeightsMessage(status).split('\n')[0]} Download them: intent pull --model ${size}`);
      }
    } else if (!(await fs.exists(`${from}/manifest.json`))) {
      throw new IntentError(`--from ${from} has no manifest.json: point it at a kev bundle directory`);
    }
    if (!(await kevRuntime.ready(fs))) {
      throw new IntentError('the kev runtime is not installed: run `intent prepare` once, then retry');
    }
    let vision = /-vision$/.test(size || '');
    if (from) vision = Boolean(JSON.parse(String(await fs.readFile(`${from}/manifest.json`))).vision);
    const started = Date.now();
    let runtime = '';
    let model;
    try {
      model = await kevRuntime.openModel(fs, exec, {
        model: size,
        from: from || null,
        // A software WebGPU adapter (SwiftShader) runs kev ~10x slower:
        // with requireGpu it stops here instead.
        requireGpu,
        log: (line) => {
          const m = /kev: (webgpu adapter .*|runtime \w+)/.exec(line);
          if (m) runtime = runtime ? `${runtime}; ${m[1]}` : m[1];
        },
        // Named in the entry script: see kev-runtime.js loadKev.
        requireBundle,
      });
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      throw new IntentError(String(err?.message || err));
    }
    const name = from ? `kev ${from.split('/').filter(Boolean).pop()}` : `kev ${size}`;
    const key = from ? from.split('/').filter(Boolean).pop().replace(/^kev-/, '') : size;
    return { name, key, kev: true, vision, runtime, loadMs: Date.now() - started, ask: (body) => model.systemOne(body) };
  }

  /**
   * The System 1 for --model: a local kev bundle by default, or Cloudflare's
   * Clef on Workers AI (--model clef | clef-flash, which needs the
   * CLOUDFLARE_API_TOKEN secret). A missing model stops with what to set
   * up; nothing falls back to a lexical guess or to another provider.
   */
  async function openSystem1(flags) {
    const asked = flags.model || DEFAULT_MODEL;
    const key = flags.from ? `from:${flags.from}` : asked;
    if (models.has(key)) return models.get(key);
    let s1;
    if (system1.REMOTE_MODELS[asked] && !flags.from) {
      const token = await system1.cloudflareToken(exec, process.env);
      if (!token) {
        throw new IntentError(
          `--model ${asked} runs on Cloudflare Workers AI: store the token first (secret set CLOUDFLARE_API_TOKEN <token> --domain api.cloudflare.com), or use the local default (--model ${DEFAULT_MODEL}).`
        );
      }
      const account = await cfAccount(flags, token);
      s1 = { name: asked, key: asked, kev: false, vision: false, ask: system1.remoteSystemOne({ fetchFn: fetch, account, token, size: asked }) };
    } else {
      s1 = await kevModel(asked, flags.from || null, flags['require-gpu'] === true || flags['require-gpu'] === 'true');
    }
    models.set(key, s1);
    return s1;
  }

  // ── the tab ───────────────────────────────────────────────────────────

  const DENIED = /approval denied|not permitted for this agent call/i;

  async function pw(argv) {
    const result = await run(['playwright-cli', ...argv]);
    if (result.exitCode !== 0 && DENIED.test(`${result.stderr}${result.stdout}`)) {
      throw new IntentError(
        'this shell may not run playwright-cli (an agent scoop whose grant leaves it out). Run `intent serve` in a shell that may, outside the scoop, while the scoop works; requests then go through it.'
      );
    }
    return result;
  }

  /** The tab for this call: --tab, else the last call's while it is open. */
  async function pickTab(req, state) {
    if (req.tab) return req.tab;
    if (!state.tab) return null;
    const alive = await js(state.tab, 'document.readyState');
    return alive.exitCode === 0 ? state.tab : null;
  }

  /** Wait for the document to load after an action, then a beat for scripts. */
  async function settle(tab) {
    await sleep(150);
    for (let i = 0; i < 40; i++) {
      const r = await js(tab, 'document.readyState');
      if (/complete/.test(r.stdout || '')) break;
      await sleep(125);
    }
    await sleep(250);
  }

  /**
   * One look at the tab. With controls: boxes, the viewport and the page scan
   * (clickable divs, names for repeated controls), as webrunner orients.
   */
  async function look(tab, { controls }) {
    const obs = await observe(tab, null, { viewport: controls });
    let states = [];
    const scanned = await js(tab, STATES_JS);
    try {
      const value = JSON.parse(scanned.stdout || '[]');
      states = Array.isArray(value) ? value : JSON.parse(value);
    } catch {
      states = [];
    }
    const named = page.addRowContext(page.applyDisambiguation(obs.shot.elements, obs.disambiguation), obs.shot.texts);
    const elements = lib.applyStates(named, states);
    return { ...obs, tab, shot: { ...obs.shot, elements } };
  }

  /** The page's text as segments, with the control states the snapshot leaves out. */
  const segmentsOf = (obs) => [...lib.textSegments(obs.raw), ...lib.stateSegments(obs.shot.elements)];

  // ── answers ───────────────────────────────────────────────────────────

  function probabilitiesOf(answer) {
    return (answer && answer.probabilities) || {};
  }

  /** The act-or-ask rule for this System 1, with --sure on top. */
  function policy(req, s1) {
    const table = lib.SURE_BY_MODEL;
    const sure = req.sure ?? table[s1.key] ?? (s1.kev ? table.kev : lib.SURE);
    return { sure, ignoreNone: Boolean(s1.kev) };
  }

  async function chooseControl(req, s1, obs, parsed) {
    const candidates = lib.controlCandidates(obs.shot.elements, obs.viewport);
    const ranked = lib.lexicalRank(candidates, lib.actQuery(req.intent, parsed), { op: parsed.op });
    const shortlist = ranked.slice(0, SHORTLIST_CONTROLS).map((r) => r.candidate);
    if (!shortlist.length) throw new IntentError('this page has no controls to act on');
    // kev answers webrunner's wording better; Clef was measured on the plain one.
    const q = lib.choiceQuestion('ACT', req.intent, shortlist, obs.shot, { style: s1.kev ? lib.QUESTION_STYLE[s1.key] || 'menu' : 'plain' });
    const image = s1.vision ? await markedShot(obs.tab, shortlist, obs.viewport) : null;
    const res = await s1.ask({ state: q.state, questions: { action: q.question }, ...(image ? { image } : {}) });
    // Answer ids may be click:eN / type:eN: name them by ref from here on.
    const probs = {};
    for (const [id, p] of Object.entries(probabilitiesOf(res.answers.action))) probs[lib.refOf(id)] = p;
    const v = lib.verdict(probs, policy(req, s1));
    const byId = new Map(shortlist.map((c) => [c.ref, c]));
    return { v, byId, shortlist };
  }

  /**
   * The screenshot with each shortlisted control boxed and labelled with its
   * ref (set-of-marks), as a kev vision bundle takes it. null when the
   * screenshot or the canvas work fails: the question still has the labels.
   */
  async function markedShot(tab, shortlist, viewport) {
    const path = `${DIR}/shot.png`;
    const r = await pw(['screenshot', `--tab=${tab}`, `--filename=${path}`]);
    if (r.exitCode !== 0) return null;
    try {
      const marked = await vision.markedImage(await fs.readFileBinary(path), shortlist, viewport);
      return marked.image;
    } catch {
      return null;
    }
  }

  /**
   * The control a --ref names. A ref is only good for the snapshot it came
   * from: when the page has changed, the last result's candidate with that
   * ref is found again by role, label and place among same-named controls.
   */
  function resolveRef(ref, obs, state) {
    const now = obs.shot.elements.find((e) => e.token === ref);
    const before = (state.candidates || []).find((c) => c.ref === ref);
    if (now && (!before || (now.role === before.role && now.label === before.label))) return now;
    if (before) {
      const same = obs.shot.elements.filter((e) => e.role === before.role && e.label === before.label);
      const again = same[before.k ? before.k - 1 : 0];
      if (again) return again;
    }
    throw new IntentError(`ref ${ref} is not on the page any more; ask again without --ref`);
  }

  /** What the shortlisted refs mean on this page, for a later --ref (lib.refMemory). */
  function remember(elements, refs) {
    const wanted = new Set(refs);
    return lib.refMemory(elements).filter((m) => wanted.has(m.ref));
  }

  /** Do the parsed operation on one control. → a past-tense phrase. */
  async function perform(tab, op, parsed, element, viewport) {
    const commands = [];
    const named = `${element.role} "${page.shown(element.label)}"`;
    const plain = !element.synthetic && !Number.isInteger(element.nth);
    if (op === 'type') {
      if (element.kind !== 'fill') throw new IntentError(`${named} is not a field to type into`);
      await act(tab, { operation: 'TYPE_TEXT', element, text: parsed.value }, viewport, commands);
      if (parsed.value === '') await pw(['press', 'Backspace', `--tab=${tab}`]);
      if (parsed.submit) await pressKey(tab, 'Enter');
      return `typed "${parsed.value}" into ${named}${parsed.submit ? ' and pressed Enter' : ''}`;
    }
    if (op === 'select' && (element.role === 'combobox' || element.role === 'listbox') && plain) {
      const r = await pw(['select', element.token, parsed.value, `--tab=${tab}`]);
      if (r.exitCode === 0) return `selected "${parsed.value}" in ${named}`;
      // Not a native <select>: an autocomplete. Type the value; its
      // suggestion is the next intent.
      await act(tab, { operation: 'TYPE_TEXT', element, text: parsed.value }, viewport, commands);
      return `typed "${parsed.value}" into ${named} (not a plain dropdown: pick the suggestion next)`;
    }
    if ((op === 'check' || op === 'uncheck') && plain && /^(checkbox|radio|switch|menuitemcheckbox)$/.test(element.role)) {
      const r = await pw([op, element.token, `--tab=${tab}`]);
      if (r.exitCode === 0) return `${op}ed ${named}`;
    }
    if (op === 'hover' && plain) {
      const r = await pw(['hover', element.token, `--tab=${tab}`]);
      if (r.exitCode === 0) return `hovered over ${named}`;
    }
    await act(tab, { operation: 'CLICK', element }, viewport, commands);
    return `clicked ${named}`;
  }

  async function doScroll(tab, direction, viewport) {
    if (direction === 'top' || direction === 'bottom') {
      await js(tab, `window.scrollTo(0, ${direction === 'top' ? 0 : 'document.documentElement.scrollHeight'})`);
    } else {
      await act(tab, { operation: 'SCROLL', direction }, viewport, []);
    }
    return `scrolled ${direction === 'top' || direction === 'bottom' ? `to the ${direction}` : direction}`;
  }

  /** The lines after an action: what changed, and the gist on a new page. */
  function afterLines(before, after) {
    const diff = page.diffShots(before.shot, { ...after.shot, viewport: after.viewport });
    const lines = lib.changeLines(diff).map((l) => `  ${l}`);
    if (diff && (diff.replaced || diff.url)) {
      lines.push(...lib.gist(after.shot, after.viewport, lib.textSegments(after.raw)).map((l) => `  ${l}`));
    }
    if (!lines.length) lines.push('  nothing visible changed');
    return { lines, diff };
  }

  // ── the kinds ─────────────────────────────────────────────────────────

  async function navigate(req, state) {
    const nav = lib.parseNavigate(req.intent);
    let tab = await pickTab(req, state);
    if (nav.op === 'goto') {
      if (!nav.url) throw new IntentError('NAVIGATE needs a URL, e.g. --intent "open https://example.com"');
      if (tab) {
        const r = await pw(['goto', nav.url, `--tab=${tab}`]);
        if (r.exitCode !== 0) throw new IntentError(`could not open ${nav.url}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      } else tab = await openTab(nav.url);
    } else {
      if (!tab) throw new IntentError('no tab yet: open a URL first');
      const verb = nav.op === 'back' ? 'go-back' : nav.op === 'forward' ? 'go-forward' : 'reload';
      await pw([verb, `--tab=${tab}`]);
    }
    await settle(tab);
    const after = await look(tab, { controls: true });
    const lines = [
      `✓ ${nav.op === 'goto' ? `opened ${after.shot.url}` : `${nav.op} to ${after.shot.url}`}  (tab ${tab})`,
      `  title: ${after.shot.title || '(none)'}`,
      ...lib.gist(after.shot, after.viewport, lib.textSegments(after.raw)).map((l) => `  ${l}`),
    ];
    return { tab, outcome: 'navigated', lines, json: { url: after.shot.url, title: after.shot.title, tab } };
  }

  async function doAct(req, state, s1) {
    const tab = await pickTab(req, state);
    if (!tab) throw new IntentError('no tab yet: start with --intent "open <url>", or pass --tab');
    const parsed = lib.parseAct(req.intent);
    const before = await look(tab, { controls: true });
    if (parsed.op === 'press' || parsed.op === 'scroll') {
      const did =
        parsed.op === 'press'
          ? (await pressKey(tab, parsed.key), `pressed ${parsed.key}`)
          : await doScroll(tab, parsed.direction, before.viewport);
      await settle(tab);
      const after = await look(tab, { controls: true });
      const { lines } = afterLines(before, after);
      return { tab, outcome: 'acted', lines: [`✓ ${did}`, ...lines], json: { did, url: after.shot.url } };
    }
    let element;
    let p = null;
    let candidates = [];
    if (req.ref) {
      element = resolveRef(req.ref, before, state);
    } else {
      const { v, byId, shortlist } = await chooseControl(req, s1, before, parsed);
      candidates = shortlist;
      p = v.p;
      const list = lib.candidateLines(v.ranked, byId, req.candidates || UNSURE_CANDIDATES);
      if (req.candidates) {
        return { tab, outcome: 'candidates', remember: remember(before.shot.elements, shortlist.map((c) => c.ref)), lines: [`candidates for "${req.intent}":`, ...list], json: { candidates: list } };
      }
      if (!v.sure) {
        return {
          tab,
          outcome: 'unsure',
          p,
          remember: remember(before.shot.elements, shortlist.map((c) => c.ref)),
          lines: [
            `? not sure which control you mean (best ${lib.pct(v.p)}); nothing done. Candidates:`,
            ...list,
            '  Say more in --intent (its label or row), or pass --ref <ref>.',
          ],
          json: { candidates: list },
        };
      }
      element = byId.get(v.pick).element;
    }
    const named = `${element.token} ${lib.describeControl({ element, rank: null, place: page.place(element, before.viewport) })}`;
    if (req.dryRun) {
      return { tab, outcome: 'dry-run', p, remember: remember(before.shot.elements, candidates.map((c) => c.ref)), lines: [`would ${parsed.op} ${named}${p != null ? `  ${lib.pct(p)}` : ''}`], json: { ref: element.token } };
    }
    const did = await perform(tab, parsed.op, parsed, element, before.viewport);
    await settle(tab);
    const after = await look(tab, { controls: true });
    const { lines } = afterLines(before, after);
    return {
      tab,
      outcome: 'acted',
      p,

      lines: [`✓ ${did} [${element.token}]${p != null ? `  ${lib.pct(p)}` : ''}`, ...lines],
      json: { did, ref: element.token, url: after.shot.url },
    };
  }

  async function retrieve(req, state, s1, flags = {}) {
    const tab = await pickTab(req, state);
    if (!tab) throw new IntentError('no tab yet: start with --intent "open <url>", or pass --tab');
    const obs = await look(tab, { controls: false });
    const segments = segmentsOf(obs);
    if (!segments.length) throw new IntentError('this page has no text');
    if (lib.isList(req.intent)) {
      // A lexical read, no model: the matching links, buttons or rows.
      const listed = lib.listLines(req.intent, obs.shot.elements, segments, req.candidates || LIST_MAX);
      return {
        tab,
        outcome: 'listed',
        remember: lib.refMemory(obs.shot.elements),
        lines: [
          listed.lines.length
            ? `${listed.lines.length} of ${listed.total} ${listed.kind} matching, in page order:`
            : `no ${listed.kind} match "${req.intent}"`,
          ...listed.lines,
        ],
        json: { items: listed.lines.map((l) => l.trim()) },
      };
    }
    const mode = RETRIEVE_MODES.includes(flags.retrieve) ? flags.retrieve : 'answer';
    const budget = Math.min(Math.max(Number(flags['retrieve-budget']) || RETRIEVE_BUDGET, 200), 6000);
    if (mode === 'lexical') {
      // Ranked by the intent's words alone, no model: the best texts until
      // the budget is spent, in the order they stand on the page.
      const ranked = lib.lexicalRank(segments, req.intent).filter((r) => r.score > 0);
      const lines = lib.budgetLines(ranked.map((r) => r.candidate), budget, req.intent);
      return { tab, outcome: 'budget', lines: [`the page's best matching texts, in page order:`, ...lines], json: { texts: lines.map((l) => l.trim()) } };
    }
    const shortlist = lib.lexicalRank(segments, req.intent).slice(0, SHORTLIST_TEXT).map((r) => r.candidate);
    const q = lib.choiceQuestion('RETRIEVE', req.intent, shortlist, obs.shot);
    const res = await s1.ask({ state: q.state, questions: { action: q.question } });
    const v = lib.verdict(probabilitiesOf(res.answers.action), policy(req, s1));
    const byId = new Map(shortlist.map((s) => [s.id, s]));
    const list = lib.candidateLines(v.ranked, byId, req.candidates || UNSURE_CANDIDATES);
    if (mode === 'budget' && !req.candidates) {
      // Ranked by System 1: the most likely texts until the budget is spent,
      // in page order, whatever its confidence in any single one.
      const byRank = v.ranked.filter(([id]) => id !== lib.NONE && byId.has(id)).map(([id]) => byId.get(id));
      const lines = lib.budgetLines(byRank, budget, req.intent);
      return { tab, outcome: 'budget', p: v.p, lines: [`the page's most likely texts, in page order (top ${lib.pct(v.p)}):`, ...lines], json: { texts: lines.map((l) => l.trim()) } };
    }
    if (req.candidates) {
      return { tab, outcome: 'candidates', p: v.p, lines: [`matches for "${req.intent}":`, ...list], json: { candidates: list } };
    }
    if (!v.sure) {
      // No single text answers it ("read the game status"): the closest
      // texts, in page order, are the answer region.
      const region = lib.regionLines(v.ranked, byId, REGION_TEXTS, req.intent);
      return {
        tab,
        outcome: 'region',
        p: v.p,
        lines: [`the page's closest texts, in page order (no single one is sure; best ${lib.pct(v.p)}):`, ...region],
        json: { region: region.map((l) => l.trim()) },
      };
    }
    const best = byId.get(v.pick);
    const also = v.p < 0.9 ? lib.candidateLines(v.ranked.filter(([id]) => id !== v.pick), byId, 2) : [];
    return {
      tab,
      outcome: 'answered',
      p: v.p,
      lines: [
        `"${lib.snippet(best.text, req.intent)}"`,
        `  ${best.ref ? `[${best.ref}] ` : ''}${best.heading ? `under "${page.shown(best.heading)}"  ` : ''}${lib.pct(v.p)}`,
        ...(also.length ? ['  also:', ...also.map((l) => `  ${l}`)] : []),
      ],
      json: { text: best.text, ref: best.ref, heading: best.heading },
    };
  }

  /** One yes/no reading of the page. → { p, evidence, shot } */
  async function judgeClaim(req, tab, s1) {
    const obs = await look(tab, { controls: false });
    const segments = segmentsOf(obs);
    const evidence = lib.lexicalRank(segments, req.intent).slice(0, EVIDENCE).map((r) => r.candidate);
    const q = lib.claimQuestion(req.intent, evidence, obs.shot);
    const which = lib.choiceQuestion('VERIFY', req.intent, evidence, obs.shot).question;
    const res = await s1.ask({ state: q.state, questions: { claim: q.question, ...(evidence.length ? { evidence: which } : {}) } });
    const p = Number(res.answers.claim.noul);
    const pick = res.answers.evidence ? res.answers.evidence.choice : null;
    return { p, evidence: evidence.find((s) => s.id === pick) || evidence[0] || null, shot: obs.shot };
  }

  const evidenceLine = (e) => (e ? `  evidence: ${lib.describeText(e, 300)}${e.ref ? ` [${e.ref}]` : ''}` : '  evidence: none on the page');

  async function verify(req, state, s1) {
    const tab = await pickTab(req, state);
    if (!tab) throw new IntentError('no tab yet: start with --intent "open <url>", or pass --tab');
    const { p, evidence, shot } = await judgeClaim(req, tab, s1);
    const sure = req.sure ?? lib.SURE;
    const word = p >= sure ? 'yes' : p <= 1 - sure ? 'no' : 'unsure';
    return {
      tab,
      outcome: word,
      p,
      lines: [`${word} (${lib.pct(p)} yes)`, evidenceLine(evidence), `  page: ${shot.title || shot.url}`],
      json: { answer: word, p, evidence: evidence ? evidence.text : null, ref: evidence ? evidence.ref : null },
    };
  }

  async function waitFor(req, state, s1) {
    const tab = await pickTab(req, state);
    if (!tab) throw new IntentError('no tab yet: start with --intent "open <url>", or pass --tab');
    const limit = (req.timeout || WAIT_DEFAULT_S) * 1000;
    const sure = req.sure ?? lib.SURE;
    const started = Date.now();
    let last = null;
    for (let round = 0; ; round++) {
      last = await judgeClaim(req, tab, s1);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (last.p >= sure) {
        return { tab, outcome: 'yes', p: last.p, lines: [`✓ holds after ${seconds} s (${lib.pct(last.p)})`, evidenceLine(last.evidence)], json: { answer: 'yes', seconds: Number(seconds) } };
      }
      if (Date.now() - started >= limit) {
        return {
          tab,
          outcome: 'timeout',
          p: last.p,
          lines: [`✗ still not after ${seconds} s (${lib.pct(last.p)} yes)`, evidenceLine(last.evidence)],
          json: { answer: 'timeout', seconds: Number(seconds), p: last.p },
        };
      }
      await sleep(1000);
    }
  }

  // ── one call ──────────────────────────────────────────────────────────

  /**
   * Handle one request; never exits the process (the daemon serves many).
   * → { stdout, exitCode }
   */
  async function handle(req, flags = {}) {
    const started = Date.now();
    const state = await readJson(STATE, {});
    let result;
    let kind = req.kind || lib.classify(req.intent).kind;
    let s1name = '';
    try {
      if (req.full) {
        const tab = await pickTab(req, state);
        if (!tab) throw new IntentError('no tab yet: start with --intent "open <url>", or pass --tab');
        const r = await pw(['snapshot', `--tab=${tab}`]);
        // Remember every ref it prints: a caller that picks one out of the
        // snapshot and passes it as --ref after the page has re-rendered
        // still reaches the same control (by role, label and order).
        const elements = page.parseSnapshot(String(r.stdout || '')).elements;
        result = {
          tab,
          outcome: 'full',
          remember: lib.refMemory(elements),
          lines: [String(r.stdout || '').trimEnd()],
          json: { snapshot: r.stdout },
        };
        kind = 'FULL';
      } else if (kind === 'NAVIGATE') {
        result = await navigate(req, state);
      } else if (kind === 'ACT' && req.ref && !req.dryRun && !req.candidates) {
        // An explicit ref needs no choice: no System 1 to load.
        result = await doAct(req, state, null);
      } else if (kind === 'RETRIEVE' && (lib.isList(req.intent) || flags.retrieve === 'lexical')) {
        // A list is read by words alone: no System 1 to load.
        result = await retrieve(req, state, null, flags);
      } else {
        const s1 = await openSystem1({ ...flags, model: req.model || flags.model });
        s1name = s1.name;
        if (kind === 'ACT') result = await doAct(req, state, s1);
        else if (kind === 'RETRIEVE') result = await retrieve(req, state, s1, flags);
        else if (kind === 'VERIFY') result = await verify(req, state, s1);
        else result = await waitFor(req, state, s1);
        if (s1.note) result.lines.push(`  (${s1.note})`);
      }
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      const message = err instanceof IntentError ? err.message : `${kind} failed: ${String(err?.message || err).slice(0, 400)}`;
      await logCall({ at: new Date().toISOString(), kind, intent: req.intent, ms: Date.now() - started, error: message });
      const text = req.json ? JSON.stringify({ ok: false, kind, error: message }) : `intent: ${message}`;
      return { stdout: '', stderr: text, exitCode: err instanceof IntentError ? err.exitCode : 1 };
    }
    await writeJson(STATE, {
      tab: result.tab,
      at: Date.now(),
      candidates: result.remember || state.candidates || [],
    });
    const stdout = req.json
      ? JSON.stringify({ ok: true, kind, outcome: result.outcome, p: result.p ?? null, tab: result.tab, ...result.json })
      : result.lines.join('\n');
    await logCall({
      at: new Date().toISOString(),
      kind,
      intent: req.intent,
      outcome: result.outcome,
      p: result.p ?? null,
      s1: s1name,
      tab: result.tab,
      ms: Date.now() - started,
      chars: stdout.length,
    });
    return { stdout, exitCode: 0 };
  }

  // ── the daemon ────────────────────────────────────────────────────────

  async function serve(flags, { stop = () => false } = {}) {
    await fs.mkdir(QUEUE, { recursive: true });
    await fs.mkdir(ANSWERS, { recursive: true });
    const beat = () => writeJson(BEAT, { at: Date.now(), model: flags.model || 'clef' }).catch(() => {});
    await beat();
    const beating = setInterval(beat, BEAT_MS);
    console.error(`intent serve: watching ${QUEUE}`);
    const failed = new Map();
    while (!stop()) {
      let names = [];
      try {
        names = (await fs.readDir(QUEUE)).filter((n) => /^[a-z0-9-]{1,40}\.json$/.test(n)).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const path = `${QUEUE}/${name}`;
        let raw;
        try {
          raw = JSON.parse(String(await fs.readFile(path)));
        } catch {
          // Half written: give it a few rounds, then drop it.
          failed.set(name, (failed.get(name) || 0) + 1);
          if (failed.get(name) > 20) await fs.rm(path).catch(() => {});
          continue;
        }
        await fs.rm(path).catch(() => {});
        const id = name.slice(0, -5);
        const { req, error } = lib.cleanRequest(raw);
        let answer;
        if (error) answer = { stdout: '', stderr: `intent: ${error}`, exitCode: 1 };
        else {
          try {
            answer = await handle(req, flags);
          } catch (err) {
            answer = { stdout: '', stderr: `intent: ${String(err?.message || err).slice(0, 400)}`, exitCode: 1 };
          }
        }
        await writeJson(`${ANSWERS}/${id}.json`, answer);
      }
      await sleep(POLL_MS);
    }
    clearInterval(beating);
    await fs.rm(BEAT).catch(() => {});
  }

  /** Hand the request to a running daemon. → its answer, or null when none runs. */
  async function viaDaemon(req) {
    const beat = await readJson(BEAT, null);
    if (!beat || Date.now() - beat.at > BEAT_FRESH_MS) return null;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writeJson(`${QUEUE}/${id}.json`, { ...req, id });
    const deadline = Date.now() + ((req.timeout || WAIT_DEFAULT_S) + 180) * 1000;
    const path = `${ANSWERS}/${id}.json`;
    while (Date.now() < deadline) {
      if (await fs.exists(path)) {
        const answer = await readJson(path, null);
        if (answer) {
          await fs.rm(path).catch(() => {});
          return answer;
        }
      }
      await sleep(POLL_MS);
    }
    throw new IntentError('the intent daemon did not answer in time (is `intent serve` still running? jshd ls)');
  }

  // warm: load System 1 now, so a missing model or a software GPU fails
  // before an agent starts depending on it.
  return { handle, serve, viaDaemon, warm: openSystem1, IntentError };
}

module.exports = { createIntent, DIR, CALLS, STATE, BEAT, WAIT_DEFAULT_S };
