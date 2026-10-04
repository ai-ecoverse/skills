// playwright-cli on one tab, shared by webrunner and intent: observe (the
// snapshot with boxes, the viewport, the page scan, a screenshot) and act
// (click, type, scroll, by ref or by place). Every playwright-cli call can
// be recorded for a trace.
//
// tabTools({ exec, say, evalJs }) binds the commands to sliccy:exec and a
// logger. evalJs(tab, expression) runs page JavaScript; by default through
// `playwright-cli eval`, which costs ~750 ms a call. A caller may pass
// sliccy:browser's eval instead, ~1 ms (measured 2026-10-02).

const page = require('./snapshot.js');
const pageScan = require('./page-scan.js');
// A long command output, cut for the trace.
const clip = (text, max) => {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
};

function tabTools({ exec, say = async () => {}, evalJs = null }) {
  // Every playwright-cli call of a cycle is recorded for the debug page.
  async function run(argv, rec) {
    const started = Date.now();
    const result = await exec.spawn(argv);
    if (rec) {
      rec.push({
        argv: argv.map((arg) => clip(arg, 300)),
        exitCode: result.exitCode,
        ms: Date.now() - started,
        stdout: clip(result.stdout, 1200),
        stderr: clip(result.stderr, 1200),
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
  // Page JavaScript: { exitCode, stdout }, like a playwright-cli eval.
  async function js(tab, expression, rec) {
    if (!evalJs) return run(['playwright-cli', 'eval', `--tab=${tab}`, expression], rec);
    const started = Date.now();
    let result;
    try {
      const value = await evalJs(tab, expression);
      result = { exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value ?? null), stderr: '' };
    } catch (err) {
      result = { exitCode: 1, stdout: '', stderr: String((err && err.message) || err) };
    }
    if (rec) rec.push({ argv: ['eval', clip(expression, 300)], exitCode: result.exitCode, ms: Date.now() - started, stdout: clip(result.stdout, 1200), stderr: clip(result.stderr, 1200) });
    return result;
  }

  async function jsOk(tab, expression, rec) {
    const result = await js(tab, expression, rec);
    if (result.exitCode !== 0) throw new Error(`eval failed: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
    return result.stdout || '';
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
  // A synthetic button (page-scan's clickable div) is clicked in the page:
  // the element under its box centre when that is the control (its text is
  // the label), else the element with exactly that text nearest the box,
  // scrolled into view first. The centre alone missed whenever the page had
  // moved since the scan: Kittens Game's "Refine catnip", 77 times in one
  // hosted run (2026-10-03).
  function clickAt(box, label = '') {
    const x = Math.round(box[0] + box[2] / 2);
    const y = Math.round(box[1] + box[3] / 2);
    return `(() => {
      const want = ${JSON.stringify(String(label).replace(/\s+/g, ' ').trim())};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const hit = document.elementFromPoint(${x}, ${y});
      const fits = (el) => el && (!want || norm(el.innerText || el.getAttribute('aria-label')) === want);
      let el = null;
      for (let n = hit; n && n !== document.body; n = n.parentElement) {
        if (fits(n)) { el = n; break; }
      }
      if (!el && hit && !want) el = hit;
      // Live counts change between the scan and the click: numbers aside.
      const series = (t) => t.replace(/\\d[\\d,.]*/g, '#');
      if (!el && want) {
        let best = null;
        for (const c of document.querySelectorAll('body *')) {
          if (series(norm(c.innerText || c.getAttribute('aria-label'))) !== series(want)) continue;
          const r = c.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const d = Math.abs(r.x + r.width / 2 - ${x}) + Math.abs(r.y + r.height / 2 - ${y});
          // The innermost element with the text: a child beats the panel around it.
          if (!best || d < best.d || (d === best.d && best.el.contains(c))) best = { el: c, d };
        }
        el = best && best.el;
        if (el) el.scrollIntoView({ block: 'center' });
      }
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
    // boxes: false, the look after an action: --boxes costs a CDP call per
    // ref (2.5–3.5× the snapshot, 2026-10-04), and the next call looks again.
    const boxes = opts.viewport && opts.boxes !== false;
    if (boxes) argv.push('--boxes');
    // A snapshot of a huge page can time out once (Wikipedia's Kurt Gödel
    // article: "CDP command timed out", 2026-10-02): try twice more, the
    // last time without boxes, which cost a CDP call per ref.
    let raw;
    for (let attempt = 1; ; attempt++) {
      const plain = attempt === 3 && boxes;
      const result = await run(plain ? argv.filter((a) => a !== '--boxes') : argv, commands);
      if (result.exitCode === 0) {
        raw = result.stdout || '';
        break;
      }
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
      if (attempt >= 3 || !/timed? ?out/i.test(detail)) {
        throw new Error(`playwright-cli snapshot failed (${result.exitCode})${detail ? `: ${detail}` : ''}`);
      }
      await say(`         snapshot timed out; retrying${attempt === 2 ? ' without boxes' : ''}`);
    }
    const shot = page.parseSnapshot(raw);
    let viewport = null;
    if (opts.viewport) {
      const evaluated = await js(tab, VIEWPORT_JS, commands);
      viewport = evaluated.exitCode === 0 ? parseViewport(evaluated.stdout) : null;
    }
    shot.viewport = viewport;
    let shotWithClicks = shot;
    let disambiguation = [];
    if (opts.viewport) {
      const found = await js(tab, PAGE_SCAN_JS, commands);
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
  // A control playwright-cli cannot reach by its ref: found in the page by
  // its name, else at its place. playwright-cli turns a ref into
  // a[aria-label=…]/a[title=…], so a link named by its content is "Element
  // not found"; its innerText may also leave out part of the name (a hidden
  // button), so the name is matched by what it contains (nameScore) too.
  // mode: 'locate' scrolls to it and returns its centre {x, y}, for a real
  // mouse click (a script's click() opens no tab: no user activation);
  // 'focus' focuses it, for typing.
  function focusByName(element, mode) {
    const box = Array.isArray(element.box) ? element.box : null;
    return `(() => {
      const nameScore = ${pageScan.nameScore.toString()};
      const want = ${JSON.stringify(element.label)};
      const role = ${JSON.stringify(element.role)};
      const box = ${JSON.stringify(box)};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const roleOf = (el) => (el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox' })[el.tagName] || (el.tagName === 'INPUT' ? 'textbox' : el.tagName)).toLowerCase();
      const namesOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.innerText, el.textContent, el.getAttribute('title')].map(norm);
      const dist = (el) => {
        if (!box) return 0;
        const r = el.getBoundingClientRect();
        return Math.abs(r.x + r.width / 2 - (box[0] + box[2] / 2)) + Math.abs(r.y + r.height / 2 - (box[1] + box[3] / 2));
      };
      let best = null;
      for (const el of document.querySelectorAll('[aria-label], [placeholder], [role], a, button, input, select, textarea, [onclick], [tabindex]')) {
        if (!visible(el)) continue;
        const score = nameScore(want, namesOf(el)) + (roleOf(el) === role ? 0.5 : 0);
        if (score < 2) continue;
        const d = dist(el);
        if (!best || score > best.score || (score === best.score && d < best.d)) best = { el, score, d };
      }
      let el = best && best.el;
      // No name matches: what stands at the control's place, as the snapshot boxed it.
      if (!el && box) el = document.elementFromPoint(box[0] + box[2] / 2, box[1] + box[3] / 2);
      if (!el) return 'missing';
      el.scrollIntoView({ block: 'center' });
      if (${JSON.stringify(mode)} === 'locate') {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        el.click();
        return 'ok';
      }
      el.focus();
      if ('value' in el) el.select && el.select();
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
      const clicked = await jsOk(tab, clickAt(action.element.box, action.element.label), commands);
      if (!clicked.includes('ok')) throw new Error(`nothing to click at "${action.element.label}"`);
      return;
    }
    const ref = action.element.token;
    const keystrokes = action.operation === 'TYPE_TEXT';
    // A ref of a repeated name reaches only the first control of that name
    // (page-scan.js), so those are clicked by their place in the page.
    if (Number.isInteger(action.element.nth)) {
      const pick = JSON.stringify({ name: action.element.label, nth: action.element.nth });
      const picked = await jsOk(tab, `(${pageScan.scan.toString()})(${pick})`, commands);
      if (picked.includes('ok')) {
        if (!keystrokes) return;
        await sh(['sleep', '0.3'], commands);
        await jsOk(tab, SELECT_FOCUSED, commands);
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
      await jsOk(tab, SELECT_FOCUSED, commands);
      await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text], commands);
      return;
    }
    const detail = `${result.stderr || ''}${result.stdout || ''}`;
    if (!/Element not found|Unknown ref/.test(detail)) {
      throw new Error(`playwright-cli click ${ref} failed: ${detail.trim().slice(0, 300)}`);
    }
    await say(`         ${ref} has no node id; focusing "${action.element.label.trim()}" by name`);
    const clicking = action.operation === 'CLICK';
    const found = await jsOk(tab, focusByName(action.element, clicking ? 'locate' : 'focus'), commands);
    if (found.includes('missing')) throw new Error(`no visible control named "${action.element.label.trim()}"`);
    const at = /"x":(-?\d+),"y":(-?\d+)/.exec(found);
    if (clicking && at) {
      await sh(['playwright-cli', 'mousemove', `--tab=${tab}`, at[1], at[2]], commands);
      await sh(['playwright-cli', 'mousedown', `--tab=${tab}`], commands);
      await sh(['playwright-cli', 'mouseup', `--tab=${tab}`], commands);
    }
    if (action.operation === 'TYPE_TEXT') {
      await sh(['playwright-cli', 'type', `--tab=${tab}`, '--', action.text], commands);
    }
  }

  return { run, sh, js, observe, waitForPage, openTab, act, hashBytes };
}

module.exports = { tabTools };
