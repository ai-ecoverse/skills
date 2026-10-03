// The decision model behind `intent`: one stated intent in, one action or
// answer out. The calling agent decides what to do next; this module only
// turns its words into a control or a piece of text on the page.
//
// 1. classify: ACT, RETRIEVE, VERIFY, WAIT_FOR or NAVIGATE, from the words.
// 2. candidates: every control (ACT) or text segment (RETRIEVE, VERIFY,
//    WAIT_FOR), ranked by a lexical score against the intent; the top few go
//    to System 1 (kev or Clef) as one choice question with a NONE option.
// 3. verdict: act on System 1's pick when it is sure; otherwise return the
//    top candidates so the caller can say more or name a ref.
//
// Pure: no I/O, no sliccy. intent.jsh does the observing and acting.

const page = require('./snapshot.js');

const KINDS = ['ACT', 'RETRIEVE', 'VERIFY', 'WAIT_FOR', 'NAVIGATE'];

// ── words ─────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    'a an the and or of to in on at for from into onto with by as is are be it its this that these those ' +
    'there here me my i you your we our us please then now just page site website current currently ' +
    'which what who whom whose when where why how do does did can could should would will shall may might'
  ).split(' ')
);

// Words that say what to do, not which control: they would match every
// "Search" button on a page where the intent says "search for".
const VERBS = new Set(
  (
    'click tap press hit push select choose pick check uncheck tick untick toggle type enter fill write input set ' +
    'put change clear open follow go navigate visit scroll hover dismiss close accept reject submit expand collapse ' +
    'show hide find locate use make sure ensure'
  ).split(' ')
);

// The caller names a control by its kind as often as by its label.
const ROLE_WORDS = {
  button: ['button', 'btn'],
  link: ['link', 'hyperlink', 'anchor'],
  textbox: ['field', 'box', 'input', 'textbox', 'textfield', 'textarea'],
  searchbox: ['search', 'field', 'box', 'input', 'searchbox', 'searchfield'],
  combobox: ['dropdown', 'drop', 'down', 'select', 'combobox', 'menu', 'picker', 'field', 'list'],
  spinbutton: ['field', 'number', 'spinner', 'input', 'box'],
  checkbox: ['checkbox', 'check', 'box', 'tickbox', 'option'],
  radio: ['radio', 'option', 'choice'],
  switch: ['switch', 'toggle'],
  tab: ['tab'],
  menuitem: ['menu', 'item', 'option'],
  option: ['option', 'suggestion', 'item', 'choice'],
  listitem: ['item', 'entry'],
  gridcell: ['cell', 'day', 'date'],
  treeitem: ['item', 'node'],
};

/** Lowercase words of a text, letters and digits of any script, lightly stemmed. */
function tokens(text) {
  const raw =
    String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      // "128GB" and "128 GB" are the same words.
      .replace(/(\p{N})(\p{L})/gu, '$1 $2')
      .replace(/(\p{L})(\p{N})/gu, '$1 $2')
      .match(/[\p{L}\p{N}]+/gu) || [];
  return raw.map(stem);
}

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const contentWords = (text) => tokens(text).filter((w) => !STOP.has(w) && !VERBS.has(w));

const squash = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

// ── 1. classify ───────────────────────────────────────────────────────

const URL_RE =
  /\b((?:https?:\/\/|www\.)[^\s"'<>]+|localhost(?::\d+)?(?:\/[^\s"'<>]*)?|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|edu|gov|de|uk|co|ai|info)(?:\/[^\s"'<>]*)?)/i;
// Asking politely changes nothing: "could you tell me …" is "tell me …".
const POLITE = /^(?:(?:please|kindly|now|ok(?:ay)?|then)[\s,]+)*(?:(?:could|can|would|will)\s+you\s+(?:please\s+)?)?/i;
const ACT_VERB =
  /^(?:click|tap|press|hit|type|enter|fill|select|choose|pick|check|uncheck|tick|scroll|hover|open|close|dismiss|accept|reject|submit|search|add|remove|expand|collapse|toggle|sort|filter|upload|drag|play|pause|log\s+in|sign\s+in)\b/i;
const CLICKING = /^(?:click|tap|press|select|choose|pick|hover|follow\s+the)\b/i;
const TYPING = /^(?:type|enter|write|input|put|insert|fill|paste)\b/i;
// Back, forward and reload of the browser, not a page's own Back button
// ("press the Back button inside the checkout wizard" is an ACT).
const HISTORY =
  /^(?:go|navigate|step|move|head)\s+(back|forward)\b|^(?:press|hit|click|use|tap)\s+(?:the\s+)?(?:browser'?s?\s+)?(back|forward|reload|refresh)(?:\s+button)?(?:\s*$|\s+(?:to|and|so)\b)|^(back|forward|reload|refresh)\b|\bbrowser'?s?\s+(?:back|forward|reload|refresh)\b/i;
const WAIT =
  /^(?:wait|pause|hold|hang\s+(?:on|tight)|keep\s+(?:checking|waiting|polling)|block|sleep|let\s+the\s+page\s+(?:settle|load|finish))\b|^until\b(?!\s+when)/i;
const VERIFY_LEAD =
  /^(?:verify|assert|(?:confirm|check|see|tell\s+me|find\s+out|test)\s+(?:that|whether|if)|is\s+it\s+true)\b/i;
// "confirm the password field is masked" states a claim; "confirm the
// booking" and "make sure the box is unchecked" ask for an action.
const VERIFY_CLAIM =
  /^(?:confirm|check|see|test)\b(?!\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,3}?(?:box|checkbox|option|radio|toggle|switch)\b)(?!.*\b(?:click|press|tap|select|choose|by|then|and\s+(?:proceed|continue|submit))\b).*\b(?:is|are|was|were|has|have|shows?|contains?|displays?|appears?|exists?|says?|reads?|matches|equals)\b/i;
const YESNO =
  /^(?:is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|shall|may|might|must|am)\b/i;
const WH = /^(?:what|which|who|whom|whose|when|where|why|how)\b/i;
const RETRIEVE_LEAD =
  /^(?:read|get|extract|list|return|copy|quote|summari[sz]e|describe|report|tell\s+me|give\s+me|show\s+me|find\s+out|look\s+up|count|note|grab|fetch)\b/i;
// A request to hand text back, wherever it sits in the sentence.
const RETRIEVE_ASK =
  /\b(?:tell\s+me|report\s+(?:back\s+)?(?:what|the|it)|return\s+(?:it|them|the\s+\w+)|read\s+(?:me|out)|and\s+list|what\s+it\s+says|give\s+me\s+the)\b|^(?:check|see|look|find)\s+(?:what|which|who|how|when|where)\b/i;
const FIND_TEXT =
  /^(?:find|look\s+for|look\s+at|check)\s+(?:the\s+|a\s+|an\s+)?(?:\w+\s+){0,3}?(?:price|cost|total|number|count|name|names|date|time|address|email|phone|status|text|title|rating|score|value|amount|fee|balance|message|error|headline|description|author|temperature|percentage)s?\b/i;

/**
 * Which kind of call an intent is. → { kind, why }.
 * - NAVIGATE: a URL to open, or back/forward/reload.
 * - WAIT_FOR: "wait until …", "wait for …".
 * - VERIFY: a yes/no claim about the page ("is the cart empty?", "verify …").
 * - RETRIEVE: a question or a request for text ("what is the total?").
 * - ACT: anything else; an imperative ("click Search", "fill the name with …").
 */
function classify(intent) {
  const full = squash(intent);
  if (!full) return { kind: 'ACT', why: 'empty' };
  const text = full.replace(POLITE, '') || full;
  if (HISTORY.test(text)) return { kind: 'NAVIGATE', why: 'history' };
  if (WAIT.test(text)) return { kind: 'WAIT_FOR', why: 'wait' };
  if (VERIFY_LEAD.test(text)) return { kind: 'VERIFY', why: 'verify verb' };
  // "are we on github.com?" asks; "click the Recreation.gov link" acts.
  if (URL_RE.test(text) && !TYPING.test(text) && !YESNO.test(text) && !CLICKING.test(text)) {
    return { kind: 'NAVIGATE', why: 'url' };
  }
  if (RETRIEVE_ASK.test(text) || FIND_TEXT.test(text)) return { kind: 'RETRIEVE', why: 'asks for text' };
  if (VERIFY_CLAIM.test(text)) return { kind: 'VERIFY', why: 'a claim to check' };
  if (YESNO.test(text)) return { kind: 'VERIFY', why: 'yes/no question' };
  if (WH.test(text) || RETRIEVE_LEAD.test(text)) return { kind: 'RETRIEVE', why: 'question' };
  // "can you click Load more?" is an action asked as a question.
  if (/\?\s*$/.test(text) && !ACT_VERB.test(text)) return { kind: 'RETRIEVE', why: 'question mark' };
  return { kind: 'ACT', why: 'imperative' };
}

/** What a NAVIGATE intent asks for. → { op: 'goto'|'back'|'forward'|'reload', url } */
function parseNavigate(intent) {
  const text = squash(intent).replace(POLITE, '');
  const h = /\b(back|forward|reload|refresh)\b/i.exec(text);
  const m = URL_RE.exec(text);
  if (!m && h) {
    const word = h[1].toLowerCase();
    return { op: word === 'refresh' ? 'reload' : word };
  }
  if (!m) return { op: 'goto', url: '' };
  let url = m[1].replace(/[.,;:!?)\]]+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `${/^localhost/i.test(url) ? 'http' : 'https'}://${url}`;
  return { op: 'goto', url };
}

// ── what an ACT intent asks for ───────────────────────────────────────

const KEYS = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  'arrow up': 'ArrowUp',
  'arrow down': 'ArrowDown',
  'arrow left': 'ArrowLeft',
  'arrow right': 'ArrowRight',
  'page down': 'PageDown',
  'page up': 'PageUp',
  home: 'Home',
  end: 'End',
};
const KEY_NAMES = Object.keys(KEYS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const PRESS_KEY = new RegExp(`^(?:press|hit|push|tap)\\s+(?:the\\s+)?(${KEY_NAMES})(?:\\s+key)?\\s*$`, 'i');
const THEN_SUBMIT = new RegExp(
  `\\s*(?:,\\s*)?(?:and|then|,)\\s+(?:then\\s+)?(?:press|hit)\\s+(?:the\\s+)?(?:enter|return)(?:\\s+key)?\\s*$|\\s*(?:,\\s*)?(?:and|then)\\s+submit(?:\\s+it)?\\s*$`,
  'i'
);

const QUOTED = /"([^"]+)"|“([^”]+)”|'([^']+)'(?!\w)|‘([^’]+)’|`([^`]+)`/g;
const quotedValues = (text) => [...String(text).matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);

// Unquoted values, in the patterns callers use. Each yields [value, rest].
const VALUE_PATTERNS = [
  // fill (out) the name field with Lars Trieloff
  [/^(?:fill|complete)(?:\s+(?:out|in))?\s+(.+?)\s+with\s+(.+)$/i, (m) => [m[2], m[1]]],
  // type/enter/write Lars Trieloff into/in the name field
  [/^(?:type|enter|write|input|put|insert)\s+(.+?)\s+(?:into|in|in\s+to|as)\s+(.+)$/i, (m) => [m[1], m[2]]],
  // set the quantity to 3 / change the name to Ada
  [/^(?:set|change|update)\s+(.+?)\s+to\s+(.+)$/i, (m) => [m[2], m[1]]],
  // select/choose/pick Medium from/in the size dropdown
  [/^(?:select|choose|pick)\s+(.+?)\s+(?:from|in|on)\s+(.+)$/i, (m) => [m[1], m[2]]],
  // search (for) Kurt Gödel (in/on the search box)
  [/^search(?:\s+for)?\s+(.+?)(?:\s+(?:in|on|using)\s+(.+))?$/i, (m) => [m[1], m[2] || 'search']],
  // type Lars Trieloff (no field named)
  [/^(?:type|enter|write|input)\s+(.+)$/i, (m) => [m[1], '']],
];

/**
 * What an ACT intent asks for: the operation, the text to type or option to
 * select, a key, and the words that name the target. Quoted text is the
 * value; unquoted, the usual phrasings ("fill the name field with Ada") are
 * understood. → { op, value, key, direction, submit, target }
 * op: click | type | select | check | uncheck | press | scroll | hover
 */
function parseAct(intent) {
  let text = squash(intent).replace(/[.!]+$/, '');
  const out = { op: 'click', value: null, key: null, direction: null, submit: false, target: text };
  if (THEN_SUBMIT.test(text)) {
    out.submit = true;
    text = text.replace(THEN_SUBMIT, '');
    out.target = text;
  }
  const press = PRESS_KEY.exec(text);
  if (press) return { ...out, op: 'press', key: KEYS[press[1].toLowerCase()], target: '' };
  const scroll = /^scroll(?:\s+(?:the\s+page\s+)?)?(?:\s+(up|down|to\s+the\s+(top|bottom)|to\s+(top|bottom)))?\s*$/i.exec(text);
  if (scroll) {
    const where = (scroll[1] || 'down').toLowerCase();
    const direction = /top/.test(where) ? 'top' : /bottom/.test(where) ? 'bottom' : where;
    return { ...out, op: 'scroll', direction, target: '' };
  }
  const scrollTo = /^scroll\s+(?:down\s+|up\s+)?(?:to|until)\s+(.+)$/i.exec(text);
  if (scrollTo) return { ...out, op: 'hover', target: scrollTo[1] };
  if (/^(?:hover|mouse\s*over)\b/i.test(text)) {
    return { ...out, op: 'hover', target: text.replace(/^(?:hover|mouse\s*over)(?:\s+(?:over|on))?\s+/i, '') };
  }
  if (/^(?:uncheck|untick|deselect|clear\s+the\s+checkbox|turn\s+off|disable)\b/i.test(text)) {
    return { ...out, op: 'uncheck', target: text };
  }
  // "check the terms box" is an action; "check that …" was VERIFY already.
  if (/^(?:check|tick|turn\s+on|enable)\b/i.test(text)) return { ...out, op: 'check', target: text };
  const quoted = quotedValues(text);
  const typing = /^(?:type|enter|write|input|put|insert|fill|complete|set|change|update|search)\b/i.test(text);
  const selecting = /^(?:select|choose|pick)\b/i.test(text);
  for (const [re, take] of VALUE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let [value, rest] = take(m);
    // A quoted value wins over the pattern's guess: 'type "Berlin" into Where from'.
    if (quoted.length) {
      const inValue = quoted.find((q) => value.includes(q));
      if (inValue) value = inValue;
      else if (quoted.length === 1 && !rest.includes(quoted[0])) value = quoted[0];
    }
    value = stripQuotes(value);
    if (!value) continue;
    // "select the Medium size" has no from/in: it is a click, handled below.
    if (selecting) return { ...out, op: 'select', value, target: rest || text };
    if (typing) return { ...out, op: 'type', value, target: rest };
  }
  if (typing && quoted.length) {
    const value = quoted[0];
    return { ...out, op: 'type', value, target: text.replace(`"${value}"`, ' ') };
  }
  if (/^clear\b/i.test(text)) return { ...out, op: 'type', value: '', target: text };
  return out;
}

/**
 * The words that name the control: for typing, the intent without the text
 * to type (a value such as "Search" must not pull in the Search button);
 * otherwise the whole intent ("select the Toronto option from the
 * suggestions" names the option by its value).
 */
function actQuery(intent, parsed) {
  if (parsed.op === 'type') return parsed.target || '';
  return squash(intent);
}

const stripQuotes = (v) =>
  squash(v)
    .replace(/^["“'‘`]+|["”'’`]+$/g, '')
    .trim();

// ── 2. candidates: controls ──────────────────────────────────────────

const ORDINALS = {
  first: 1,
  '1st': 1,
  top: 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  last: -1,
  bottom: -1,
};
const ORDINAL_RE = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\b`, 'i');

const REGION_NAMES = {
  search: 'in the search form',
  form: 'in a form',
  dialog: 'in a dialog',
  alertdialog: 'in a dialog',
  banner: 'in the header',
  navigation: 'in the navigation',
  contentinfo: 'in the footer',
  complementary: 'in a sidebar',
  listbox: 'in a suggestion list',
};

const nth = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/**
 * The page's controls as candidates: every control, with its place among
 * controls of the same label ("3rd of 30") so the model can follow
 * "the top story's comments", its row context, its region, and whether it
 * is on screen. viewport may be null (no boxes).
 */
function controlCandidates(elements, viewport) {
  // Labels that differ only in their numbers are one series: Hacker News'
  // "165 comments", "21 comments", … are the 1st, 2nd, … of 30.
  const series = (label) => String(label).replace(/\d[\d,.]*/g, '#');
  const total = new Map();
  for (const e of elements) total.set(series(e.label), (total.get(series(e.label)) || 0) + 1);
  const seen = new Map();
  return elements
    .filter((e) => !(e.kind === 'click' && e.label.length > 200))
    .map((e) => {
      const key = series(e.label);
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      const n = total.get(key);
      return {
        type: 'control',
        element: e,
        ref: e.token,
        rank: n > 1 ? { k, n } : null,
        place: page.place(e, viewport),
      };
    });
}

/** How a control candidate reads to the model and to the caller. */
function describeControl(c) {
  const e = c.element;
  const parts = [page.named(e)];
  if (e.kind === 'fill') parts.push(e.value ? `= "${page.shown(e.value)}"` : '(empty)');
  if (e.state) parts.push(`(${e.state})`);
  else if (e.kind !== 'fill' && e.value) parts.push(`= "${page.shown(e.value)}"`);
  if (c.rank) parts.push(`(${nth(c.rank.k)} of ${c.rank.n})`);
  if (REGION_NAMES[e.region]) parts.push(REGION_NAMES[e.region]);
  if (c.place === 'above' || c.place === 'below') parts.push('off screen');
  return parts.join(' ');
}

/**
 * The page's control states (page-scan.js states) on the snapshot's
 * elements: the k-th scanned control of a role and name is the k-th
 * element of that role and name (case and spacing aside). A checkable
 * control without a value gets its state as the value, so the diff says
 * `radio "Medium" now "checked"`.
 */
function applyStates(elements, states) {
  if (!states || !states.length) return elements;
  const key = (role, name) => `${role}|${squash(name).toLowerCase()}`;
  const scanned = new Map();
  for (const s of states) {
    const k = key(s.role, s.name);
    if (!scanned.has(k)) scanned.set(k, []);
    scanned.get(k).push(s);
  }
  const seen = new Map();
  return elements.map((e) => {
    const k = key(e.role, e.label);
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    const hit = (scanned.get(k) || [])[n];
    if (!hit) return e;
    const out = { ...e, state: hit.state };
    if (e.kind !== 'fill' && !e.value) out.value = hit.state;
    return out;
  });
}

/** Control states as text segments, for RETRIEVE and VERIFY ("is Medium selected?"). */
function stateSegments(elements) {
  return elements
    .filter((e) => e.state)
    .map((e, i) => ({
      type: 'text',
      id: `s${i + 1}`,
      text: `${e.role} "${page.shown(e.label)}"${e.context ? ` for "${e.context}"` : ''}: ${e.state}`,
      role: e.role,
      ref: e.token,
      box: e.box || null,
      region: e.region || '',
      heading: '',
    }));
}

/**
 * What a ref means, so a later --ref still finds its control after the page
 * re-renders and renumbers: role, label, and which of the controls with that
 * exact role and label it is (k, from 1). → [{ ref, role, label, k }]
 */
function refMemory(elements) {
  const seen = new Map();
  return elements
    .filter((e) => e.token)
    .map((e) => {
      const key = `${e.role}|${e.label}`;
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      return { ref: e.token, role: e.role, label: e.label, k };
    });
}

/** Which controls an ACT operation can apply to. */
function fitsOp(c, op) {
  const role = c.element.role;
  if (op === 'type') return c.element.kind === 'fill';
  if (op === 'select') return role === 'combobox' || role === 'listbox' || role === 'option' || role === 'radio' || role === 'menuitem' || role === 'button' || role === 'link';
  if (op === 'check' || op === 'uncheck') return role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox';
  return true;
}

// ── 2. candidates: text segments ─────────────────────────────────────

const LINE_RE =
  /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:\\.|[^"\\])*)")?((?: \[[^\]]*\])*)(?:: "?((?:\\.|[^"\\])*)"?)?\s*$/;
const BLOCKS = new Set([
  'paragraph',
  'row',
  'listitem',
  'heading',
  'blockquote',
  'caption',
  'figcaption',
  'term',
  'definition',
  'alert',
  'status',
  'dialog',
  'alertdialog',
  'note',
  'article',
  'cell',
  'gridcell',
  'option',
  'group',
  'region',
  'figure',
  'log',
  'marquee',
  'timer',
  'tooltip',
]);
// Roles whose name is page text a reader sees (a link's or button's label counts).
const TEXTY = new Set([
  'text',
  'statictext',
  'heading',
  'link',
  'button',
  'cell',
  'gridcell',
  'rowheader',
  'columnheader',
  'row',
  'listitem',
  'paragraph',
  'option',
  'term',
  'definition',
  'caption',
  'alert',
  'status',
  'strong',
  'emphasis',
  'code',
  'mark',
  'time',
  'label',
  'legend',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
]);
const MAX_SEGMENT = 400;
const unescape = (v) => v.replace(/\\([\\n"])/g, (_, ch) => (ch === 'n' ? '\n' : ch));

/** The snapshot as a tree: { role, name, value, ref, box, children, line }. */
function snapshotTree(raw) {
  const root = { role: 'root', name: '', children: [], indent: -1, line: 0 };
  const stack = [root];
  let lineNo = 0;
  for (const line of String(raw).split('\n')) {
    lineNo++;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const attrs = m[4] || '';
    const ref = /\[ref=([^\]]+)\]/.exec(attrs);
    const box = /\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(attrs);
    const node = {
      role: m[2].toLowerCase(),
      name: m[3] ? unescape(m[3]) : '',
      value: m[5] ? unescape(m[5]) : '',
      ref: ref ? ref[1] : null,
      box: box ? box.slice(1, 5).map(Number) : null,
      children: [],
      indent,
      line: lineNo,
    };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

/** A node's reading text: its name when it carries one, else its children's. */
const FIELD_ROLES = /^(textbox|searchbox|combobox|spinbutton)$/;

function nodeText(node) {
  if (node.role === 'row' && node.name) return squash(node.name);
  // A field's name repeats its label's text; what it holds is its value.
  if (FIELD_ROLES.test(node.role)) return squash(node.value);
  const own = TEXTY.has(node.role) ? squash(node.name || node.value) : '';
  const kids = node.children.map(nodeText).filter(Boolean);
  if (!kids.length) return own;
  const joined = squash(kids.join(' '));
  // A link or heading whose name repeats its children's text: say it once.
  if (own && joined.includes(own)) return joined;
  if (own && own.includes(joined)) return own;
  return squash(`${own} ${joined}`);
}

function firstRef(node) {
  if (node.ref) return { ref: node.ref, box: node.box };
  for (const c of node.children) {
    const r = firstRef(c);
    if (r) return r;
  }
  return null;
}

function splitLong(text, max = MAX_SEGMENT) {
  const out = [];
  let cur = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + sentence.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    if (sentence.length > max) {
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
    } else cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) out.push(cur);
  return out;
}

const LANDMARK = new Set(['banner', 'navigation', 'contentinfo', 'main', 'search', 'form', 'dialog', 'complementary']);

/**
 * The page's text as segments a question can be answered from: the largest
 * block (row, paragraph, list item, heading, …) whose text fits in 400
 * characters, so a label and its value ("Born | April 28, 1906") stay
 * together. A longer block is split into sentences. Each segment keeps the
 * first ref and box inside it, its landmark region, and its heading.
 * Field values count too ("textbox "Search" = "Kurt"").
 */
function textSegments(raw) {
  const tree = snapshotTree(raw);
  const out = [];
  const seen = new Set();
  let heading = '';
  const add = (text, node, region) => {
    const t = squash(text);
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    const at = firstRef(node) || {};
    out.push({
      type: 'text',
      id: `t${out.length + 1}`,
      text: t,
      role: node.role,
      ref: at.ref || null,
      box: at.box || null,
      region,
      heading: node.role === 'heading' ? '' : heading,
      line: node.line,
    });
  };
  const walk = (node, region) => {
    const here = LANDMARK.has(node.role) ? node.role : region;
    if (node.role === 'heading') {
      heading = squash(nodeText(node));
      add(heading, node, here);
      return;
    }
    if (FIELD_ROLES.test(node.role)) {
      add(`${node.role} "${squash(node.name)}" = "${squash(node.value)}"`, node, here);
      return;
    }
    if (BLOCKS.has(node.role) || node.role === 'text' || node.role === 'statictext') {
      const text = nodeText(node);
      if (text.length <= MAX_SEGMENT) {
        add(text, node, here);
        // The block's fields still get a segment each, with their values.
        const fields = (n) => (FIELD_ROLES.test(n.role) ? [n] : n.children.flatMap(fields));
        for (const f of node.children.flatMap(fields)) walk(f, here);
        return;
      }
      // Too long to be one answer: its blocks are, else its sentences.
      const blockKids = node.children.filter((c) => BLOCKS.has(c.role) || c.children.length);
      if (!blockKids.length || node.role === 'paragraph' || node.role === 'text') {
        for (const part of splitLong(text)) add(part, node, here);
        return;
      }
    }
    for (const c of node.children) walk(c, here);
  };
  walk(tree, '');
  return out;
}

const CHROME = new Set(['banner', 'navigation', 'contentinfo']);

/** How a text segment reads to the model and the caller. */
function describeText(s, max = 200) {
  const t = s.text.length > max ? `${s.text.slice(0, max - 1)}…` : s.text;
  return `"${t}"`;
}

// ── lexical ranking ──────────────────────────────────────────────────

/** The words a candidate offers to match against, with weights. */
function candidateWords(c) {
  if (c.type === 'text') {
    return [
      [tokens(c.text), 1],
      [tokens(c.heading || ''), 0.3],
    ];
  }
  const e = c.element;
  return [
    [tokens(e.label), 2],
    [tokens(e.context || ''), 0.8],
    [tokens(e.value || ''), 0.6],
    [ROLE_WORDS[e.role] || [e.role], 0.5],
  ];
}

/**
 * Rank candidates by the intent's words: idf-weighted overlap with each
 * candidate's label (controls) or text (segments), a bonus when the whole
 * label appears in the intent, an ordinal ("first", "last") that picks one
 * of repeated controls, and a small one for being on screen. Chrome
 * (header, navigation, footer) ranks lower unless the intent names it.
 * → [{ candidate, score }] best first; ties keep page order.
 */
function lexicalRank(candidates, query, opts = {}) {
  const q = contentWords(query);
  const qset = new Set(q);
  const N = candidates.length || 1;
  const df = new Map();
  const docs = candidates.map((c) => {
    const fields = candidateWords(c).map(([words, w]) => [new Set(words), w]);
    const all = new Set();
    for (const [words] of fields) for (const w of words) all.add(w);
    for (const w of all) df.set(w, (df.get(w) || 0) + 1);
    return fields;
  });
  const idf = (w) => Math.log(1 + N / (df.get(w) || 0.5));
  const phrase = ` ${tokens(query).join(' ')} `;
  const ordinal = ORDINAL_RE.exec(String(query));
  const want = ordinal ? ORDINALS[ordinal[1].toLowerCase()] : 0;
  const mentionsChrome = /\b(header|nav|navigation|menu|footer|sidebar|top\s+bar)\b/i.test(query);
  const scored = candidates.map((c, index) => {
    let score = 0;
    for (const [words, w] of docs[index]) {
      for (const word of qset) {
        if (words.has(word)) score += w * idf(word);
        else if (word.length >= 3) {
          // "statistics" and "Stats", "photo" and "photography": half credit.
          for (const other of words) {
            if (other.length >= 3 && (other.startsWith(word) || word.startsWith(other))) {
              score += 0.5 * w * idf(other);
              break;
            }
          }
        }
      }
    }
    const label = c.type === 'control' ? c.element.label : c.text;
    const lt = tokens(label).join(' ');
    if (lt && lt.length >= 2 && phrase.includes(` ${lt} `)) {
      // A whole label in the intent is strong evidence, a one-word label
      // ("comments") much less: the word already counted above.
      const n = lt.split(' ').length;
      score += n > 1 ? 2 + Math.min(3, n) : 1;
    }
    if (want && c.rank) {
      const hit = want === -1 ? c.rank.k === c.rank.n : c.rank.k === want;
      if (hit && score > 0) score += 2;
    }
    if (c.place === 'in') score += 0.3;
    if (c.place === 'hidden') score -= 2;
    const region = c.type === 'control' ? c.element.region : c.region;
    if (CHROME.has(region) && !mentionsChrome) score -= 0.5;
    // Typing needs a field; a select or check on another kind of control is
    // still possible (a custom dropdown's option, a div styled as a box).
    if (opts.op && c.type === 'control' && !fitsOp(c, opts.op)) score -= opts.op === 'type' ? 100 : 1.5;
    return { candidate: c, score, index };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index);
}

// ── 3. System 1's question and verdict ───────────────────────────────

const NONE = 'NONE';

/**
 * One choice question over the top candidates, with NONE for "none of
 * these". The state is the intent and where the page is; each option is a
 * candidate as describeControl/describeText reads it.
 */
function choiceQuestion(kind, intent, shortlist, shot, opts = {}) {
  if (kind === 'ACT' && opts.style === 'menu') return menuQuestion(intent, shortlist, shot);
  const state = [`Intent: ${squash(intent)}`, `Page: ${shot.title || ''} (${shot.url || ''})`].join('\n');
  const criteria = {};
  for (const c of shortlist) {
    criteria[c.type === 'control' ? c.ref : c.id] = c.type === 'control' ? describeControl(c) : describeText(c);
  }
  criteria[NONE] = kind === 'ACT' ? 'none of these controls is the one the intent means' : 'none of these texts answers it';
  const instructions =
    kind === 'ACT'
      ? 'Which control does the intent mean?'
      : kind === 'RETRIEVE'
        ? 'Which text on the page answers the intent?'
        : 'Which text on the page shows whether the intent holds?';
  return { state, question: { type: 'choice', instructions, criteria } };
}

/**
 * The ACT question as webrunner asks kev (meep-meep, #423): the intent as
 * the goal, the shortlist as a Controls list in the state, and one action
 * per control (click:eN, type:eN). On 400 Mind2Web intents kev-4b-vision
 * picked right 88.6% of the time this way and 83.2% with the plain
 * question above; the 0.8b bundles did as well or better (2026-10-03).
 * Ids map back to refs with refOf.
 */
function menuQuestion(intent, shortlist, shot) {
  const id = (c) => `${c.element.kind === 'fill' ? 'type' : 'click'}:${c.ref}`;
  const criteria = {};
  for (const c of shortlist) criteria[id(c)] = `${c.element.kind === 'fill' ? 'type into' : 'click'} ${describeControl(c)}`;
  criteria[NONE] = 'none of these controls is the one the intent means';
  const state = [
    `Goal: ${squash(intent)}`,
    `Page: ${shot.title || ''} (${shot.url || ''})`,
    'Controls:',
    ...shortlist.map((c) => `  [${c.ref}] ${describeControl(c)}`),
  ].join('\n');
  return { state, question: { type: 'choice', instructions: 'Which single action advances the goal next?', criteria } };
}

/** The ref an answer id names: e12 or click:e12. */
const refOf = (id) => (id == null ? id : String(id).replace(/^(click|type):/, ''));

/** The yes/no question for VERIFY and WAIT_FOR, over the evidence segments. */
function claimQuestion(intent, evidence, shot) {
  const claim = squash(intent)
    .replace(/^(?:wait\s+(?:until|for|till)|until)\s+/i, '')
    .replace(/^(?:verify|confirm|assert|check)\s+(?:that|whether|if)?\s*/i, '');
  const state = [
    `Page: ${shot.title || ''} (${shot.url || ''})`,
    'Page text:',
    ...evidence.map((s) => `  ${describeText(s, 300)}`),
  ].join('\n');
  return {
    state,
    question: { type: 'noul', instructions: `Is this true of the page: ${claim}` },
  };
}

// Act or answer when System 1's top choice is at least this likely. Each
// System 1 has its own: measured on 400 Mind2Web steps (2026-10-02/03, see
// SKILL.md), at the threshold where about 3% of intents end in a wrong action.
const SURE = 0.7;
const SURE_BY_MODEL = {
  clef: 0.7, // acts on 74.5% of intents, 3.3% wrong
  'clef-flash': 0.7,
  // 4b-vision: 0.7 acted on 72% (2.7% wrong), but the hosted smoke round
  // (2026-10-03) left obvious picks unsure at 0.63-0.69; 0.6 acts on 79.3%
  // with 4.3% wrong, and the caller sees every result and can recover.
  '4b-vision': 0.6,
  '0.8b-vision-wr1': 0.7, // the webrunner fine-tune: 74.5%, 5% wrong
  '0.8b-vision': 0.4, // under-confident: 49%, 2.8% wrong
  kev: 0.5, // any other bundle
};

/**
 * Whether to act on System 1's answer. → { pick, p, sure, ranked: [[id, p]] }
 * With ignoreNone (kev, whose NONE often wins over a right but unsure
 * choice), the best other choice decides; otherwise a winning NONE means
 * not sure. Not sure also when the choice is below `sure`.
 */
function verdict(probabilities, opts = {}) {
  const sure = opts.sure ?? SURE;
  const ranked = Object.entries(probabilities || {}).sort((a, b) => b[1] - a[1]);
  const pool = opts.ignoreNone ? ranked.filter(([id]) => id !== NONE) : ranked;
  const [top] = pool;
  if (!top) return { pick: null, p: 0, sure: false, ranked };
  return { pick: top[0] === NONE ? null : top[0], p: top[1], sure: top[0] !== NONE && top[1] >= sure, ranked };
}

// ── output ────────────────────────────────────────────────────────────

const pct = (p) => `${Math.round((p || 0) * 100)}%`;

/** The few lines that tell the caller what an action changed. */
function changeLines(diff, max = 6) {
  if (!diff) return [];
  const lines = [];
  if (diff.url) lines.push(`url: ${diff.url.to}`);
  if (diff.title) lines.push(`title: ${diff.title.to}`);
  for (const c of diff.changed.slice(0, 3)) lines.push(`${c.role} "${page.shown(c.label)}" now "${page.shown(c.to)}"`);
  if (diff.scrolled) lines.push(`scrolled ${diff.scrolled > 0 ? 'down' : 'up'} ${Math.abs(diff.scrolled)} px`);
  const said = diff.texts.filter((t) => ['alert', 'status', 'heading'].includes(t.role)).slice(0, 2);
  for (const t of said) lines.push(`${t.role === 'heading' ? 'heading' : 'message'}: "${page.shown(t.text)}"`);
  if (diff.replaced) {
    lines.push(`new page: ${diff.added.length} new controls, ${diff.removed.length} gone`);
  } else {
    if (diff.added.length) {
      const shown = diff.added.slice(0, 5).map((e) => `${e.token} ${e.role} "${page.shown(e.label)}"`);
      lines.push(`appeared: ${shown.join(', ')}${diff.added.length > 5 ? `, +${diff.added.length - 5} more` : ''}`);
    }
    if (diff.removed.length) lines.push(`gone: ${diff.removed.length} control${diff.removed.length === 1 ? '' : 's'}`);
  }
  return lines.slice(0, max);
}

/**
 * A page in a few lines, for after a navigation or a page change: the
 * headings, the fields, and the most prominent controls on screen. The
 * caller cannot see the page; this is what it forms its next intent from.
 */
function gist(shot, viewport, segments, max = 8) {
  const lines = [];
  const heads = (segments || []).filter((s) => s.role === 'heading' && !CHROME.has(s.region)).slice(0, 4);
  if (heads.length) lines.push(`headings: ${heads.map((s) => `"${page.shown(s.text)}"`).join(', ')}`);
  const fields = shot.elements.filter((e) => e.kind === 'fill').slice(0, 5);
  if (fields.length) {
    lines.push(`fields: ${fields.map((e) => `${e.token} ${e.role} "${page.shown(e.label)}"${e.value ? ` = "${page.shown(e.value)}"` : ''}`).join(', ')}`);
  }
  const buttons = shot.elements
    .filter((e) => e.kind === 'click' && e.role === 'button' && page.place(e, viewport) !== 'hidden' && e.label.length <= 40)
    .slice(0, 6);
  if (buttons.length) lines.push(`buttons: ${buttons.map((e) => `${e.token} "${e.label}"`).join(', ')}`);
  const links = shot.elements.filter((e) => e.role === 'link').length;
  lines.push(`${shot.elements.length} controls (${links} links)${viewport ? `, page ${Math.round((viewport.scrollHeight || 0) / Math.max(1, viewport.height))} screens tall` : ''}`);
  return lines.slice(0, max);
}

/**
 * A long text cut to the part the query is about: the window of `max`
 * characters with the most query words, on word boundaries.
 */
function snippet(text, query, max = 240) {
  const t = squash(text);
  if (t.length <= max) return t;
  const want = new Set(contentWords(query));
  const words = t.split(' ');
  const hit = words.map((w) => tokens(w).some((x) => want.has(x)));
  // The densest stretch of half the window, then the window around it, so
  // what follows the asked-about words (the value) is in.
  const half = Math.max(1, Math.round(max / 2 / 7));
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < words.length; i++) {
    let score = 0;
    for (let j = i; j < Math.min(words.length, i + half); j++) if (hit[j]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  let start = best;
  let len = 0;
  // A little context before the first hit.
  while (start > 0 && len + words[start - 1].length + 1 <= max / 4) {
    start--;
    len += words[start].length + 1;
  }
  const out = [];
  len = 0;
  for (let j = start; j < words.length && len + words[j].length + 1 <= max; j++) {
    out.push(words[j]);
    len += words[j].length + 1;
  }
  return `${start > 0 ? '…' : ''}${out.join(' ')}${start + out.length < words.length ? '…' : ''}`;
}

// "list the links about drugs", "list the rows that mention calories": a
// lexical read, no model. Controls when the intent names a kind of control,
// else the page's text rows.
const LIST_RE = /^(?:please\s+)?(?:list|show\s+me\s+all|enumerate)\b/i;
const LIST_CONTROLS = /\b(links?|buttons?|controls?|options?|fields?|tabs?|checkboxes|menu\s+items?)\b/i;
const isList = (intent) => LIST_RE.test(squash(intent));

/**
 * The listing for a "list … about X" intent: up to n matches in page order,
 * one short line each with its ref. With no word to match (list the
 * buttons), every item of the kind, in page order.
 */
function listLines(intent, elements, segments, n = 20) {
  const text = squash(intent);
  const wantsControls = LIST_CONTROLS.test(text);
  const kind = wantsControls ? LIST_CONTROLS.exec(text)[1].toLowerCase() : '';
  const roleOk = (e) =>
    /^link/.test(kind)
      ? e.role === 'link'
      : /^button/.test(kind)
        ? e.role === 'button'
        : /^(field|checkbox)/.test(kind)
          ? e.kind === 'fill' || e.role === 'checkbox'
          : /^tab/.test(kind)
            ? e.role === 'tab'
            : true;
  // The words after the kind ("about drugs", "that mention calories").
  const about = wantsControls ? text.slice(text.search(LIST_CONTROLS) + kind.length) : text.replace(LIST_RE, '');
  const words = contentWords(about).filter((w) => !['list', 'row', 'item', 'all', 'mention', 'about', 'page'].includes(w));
  const pool = wantsControls ? controlCandidates(elements.filter(roleOk), null) : segments;
  const ranked = words.length ? lexicalRank(pool, words.join(' ')).filter((r) => r.score > 0.5) : pool.map((c, index) => ({ candidate: c, index }));
  const picked = ranked.slice(0, n).map((r) => r.candidate);
  const order = (c) => (c.type === 'control' ? c.element.seq ?? 0 : c.line ?? 0);
  picked.sort((a, b) => order(a) - order(b));
  const lines = picked.map((c) =>
    c.type === 'control' ? `  ${c.ref} ${describeControl(c)}` : `  ${c.ref || c.id} ${describeText(c, 160)}`
  );
  return { lines, total: ranked.length, kind: wantsControls ? kind : 'rows' };
}

/**
 * When System 1 cannot point at one text: the best few texts, in the order
 * they stand on the page, so "read the game status" still gets the part of
 * the page it is about, compactly.
 */
function regionLines(ranked, byId, n = 6, query = '') {
  const picked = ranked
    .filter(([id]) => id !== NONE && byId.has(id))
    .slice(0, n)
    .map(([id]) => byId.get(id));
  picked.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return picked.map((c) => `  ${c.ref || c.id} "${snippet(c.text, query, 220)}"`);
}

/** The top candidates when System 1 is not sure, for the caller to choose from. */
function candidateLines(ranked, byId, max = 5) {
  return ranked
    .filter(([id]) => id !== NONE && byId.has(id))
    .slice(0, max)
    .map(([id, p]) => {
      const c = byId.get(id);
      const where = c.type === 'control' ? c.ref : c.ref ? `${c.ref}` : c.id;
      return `  ${where}  ${c.type === 'control' ? describeControl(c) : describeText(c)}  ${pct(p)}`;
    });
}

// ── requests (CLI flags and the daemon's request files) ──────────────

// playwright-cli refs (e12, a frame's f1e3) and synthetic controls (c4).
const REF_RE = /^[a-z]{1,2}\d{1,6}(?:[a-z]\d{1,6})?$/;
const TAB_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INTENT = 2000;
const REQUEST_FIELDS = new Set(['id', 'intent', 'kind', 'ref', 'tab', 'sure', 'candidates', 'dryRun', 'full', 'timeout', 'json', 'model']);
const MODELS = ['4b-vision', '0.8b-vision', '4b', '0.8b', 'clef', 'clef-flash'];

/**
 * One call's request, checked field by field. The daemon (intent serve)
 * runs browser commands for a scoop that may not, so a request is intent
 * fields only: never an argv, a URL to fetch, or a shell string. Unknown
 * fields are refused. → { req } or { error }
 */
function cleanRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'a request is a JSON object' };
  for (const key of Object.keys(raw)) if (!REQUEST_FIELDS.has(key)) return { error: `unknown field ${JSON.stringify(key)}` };
  const req = {};
  if (typeof raw.intent !== 'string' || !squash(raw.intent)) return { error: '--intent is required: say what you want, e.g. --intent "click the Search button"' };
  if (raw.intent.length > MAX_INTENT) return { error: `--intent is over ${MAX_INTENT} characters` };
  req.intent = squash(raw.intent);
  if (raw.id != null) {
    if (typeof raw.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(raw.id)) return { error: 'bad request id' };
    req.id = raw.id;
  }
  if (raw.kind != null) {
    const kind = String(raw.kind).toUpperCase().replace(/-/g, '_');
    if (!KINDS.includes(kind)) return { error: `--kind is one of ${KINDS.join(', ').toLowerCase()}` };
    req.kind = kind;
  }
  if (raw.ref != null) {
    if (typeof raw.ref !== 'string' || !REF_RE.test(raw.ref)) return { error: `--ref takes a ref from an earlier result, such as e12 (got ${JSON.stringify(String(raw.ref).slice(0, 20))})` };
    req.ref = raw.ref;
  }
  if (raw.tab != null) {
    if (typeof raw.tab !== 'string' || !TAB_RE.test(raw.tab)) return { error: '--tab takes a tab id from `playwright-cli tab-list` or an earlier result' };
    req.tab = raw.tab;
  }
  if (raw.model != null) {
    if (!MODELS.includes(raw.model)) return { error: `--model is one of ${MODELS.join(', ')}` };
    req.model = raw.model;
  }
  const num = (key, min, max) => {
    if (raw[key] == null) return null;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < min || n > max) return `--${key} is a number from ${min} to ${max}`;
    req[key] = n;
    return null;
  };
  const bad = num('sure', 0, 1) || num('candidates', 1, 20) || num('timeout', 1, 300);
  if (bad) return { error: bad };
  if (req.candidates != null) req.candidates = Math.round(req.candidates);
  for (const key of ['dryRun', 'full', 'json']) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== 'boolean') return { error: `${key} is true or false` };
    req[key] = raw[key];
  }
  return { req };
}

module.exports = {
  REF_RE,
  MODELS,
  cleanRequest,
  KINDS,
  NONE,
  SURE,
  SURE_BY_MODEL,
  tokens,
  stem,
  contentWords,
  classify,
  parseNavigate,
  parseAct,
  actQuery,
  quotedValues,
  controlCandidates,
  describeControl,
  applyStates,
  stateSegments,
  fitsOp,
  snapshotTree,
  textSegments,
  describeText,
  lexicalRank,
  choiceQuestion,
  menuQuestion,
  refOf,
  claimQuestion,
  verdict,
  changeLines,
  gist,
  candidateLines,
  refMemory,
  isList,
  listLines,
  regionLines,
  snippet,
  pct,
};
