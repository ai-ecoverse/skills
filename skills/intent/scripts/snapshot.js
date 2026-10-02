// The snapshot side of the intent tool: parse `playwright-cli snapshot
// --boxes`, name controls, pair them with the page scan, place them in the
// viewport, diff two snapshots, and read the page's text.
//
// Copied from meep-meep's scripts/page.js (ai-ecoverse/skills#423), which
// is not on main yet. Deduplicate once #423 lands: both skills should
// require one module. No network, no sliccy.

const LINE =
  /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:\\.|[^"\\])*)")?(?: \[ref=([^\]]+)\])?(?:: "?((?:\\.|[^"\\])*)"?)?(.*)$/;

const BOX = / \[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/;

const TEXT_ROLES = new Set(['alert', 'status', 'heading', 'statictext', 'text', 'row']);

const CLICK_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'listitem',
  'gridcell',
  'treeitem',
]);

const FILL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const LANDMARKS = new Set([
  'search',
  'form',
  'dialog',
  'alertdialog',
  'main',
  'banner',
  'navigation',
  'contentinfo',
  'complementary',
]);

function unescapeYaml(value) {
  return value.replace(/\\([\\n"])/g, (_, ch) => (ch === 'n' ? '\n' : ch));
}

function parseSnapshot(text) {
  let url = '';
  let title = '';
  const elements = [];
  const texts = [];
  // [indent, role] of the open landmarks above the current line
  const stack = [];
  let lineNo = 0;
  for (const line of String(text).split('\n')) {
    lineNo++;
    const boxMatch = BOX.exec(line);
    const raw = boxMatch ? line.replace(BOX, '') : line;
    const urlMatch = /^Page URL:\s*(.*)$/.exec(raw.trim());
    if (urlMatch) {
      url = urlMatch[1].trim();
      continue;
    }
    const titleMatch = /^Page Title:\s*(.*)$/.exec(raw.trim());
    if (titleMatch && !title) {
      title = titleMatch[1].trim();
      continue;
    }
    const match = LINE.exec(raw);
    if (!match) continue;
    const indent = match[1].length;
    const role = match[2].toLowerCase();
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    if (LANDMARKS.has(role) || role === 'listbox') stack.push([indent, role]);
    if (TEXT_ROLES.has(role) && match[3]) {
      const t = { role, text: unescapeYaml(match[3]), seq: lineNo };
      if (match[4]) t.token = match[4];
      if (stack.length) t.region = stack[stack.length - 1][1];
      if (boxMatch) t.box = boxMatch.slice(1, 5).map(Number);
      texts.push(t);
    }
    if (!match[4]) continue;
    if (!CLICK_ROLES.has(role) && !FILL_ROLES.has(role)) continue;
    const element = {
      token: match[4],
      role,
      label: match[3] ? unescapeYaml(match[3]) : role,
      kind: FILL_ROLES.has(role) ? 'fill' : 'click',
      region: stack.length ? stack[stack.length - 1][1] : '',
      seq: lineNo,
    };
    if (match[5] !== undefined && match[5] !== '') element.value = unescapeYaml(match[5]);
    if (boxMatch) element.box = boxMatch.slice(1, 5).map(Number);
    elements.push(element);
  }
  return { url, title, elements, texts };
}

const MAX_LABEL = 100;

const MAX_CONTROL_LABEL = 200;

function shown(label) {
  const text = String(label);
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

const MAX_CLICKABLE_SHARE = 0.4;

/**
 * Click targets the snapshot does not show. Games and many sites build
 * buttons from divs: Kittens Game's "Gather catnip", A Dark Room's "light
 * fire", Seedship's "New game" (probed 2026-10-02). The accessibility tree
 * merges their labels into one text node without a box, so they cannot be
 * clicked by ref. The page reports them instead: `found` is
 * [{ t: text, b: [x, y, w, h] }] for visible elements with a pointer
 * cursor, an onclick, a tabindex or a button class. Each becomes a
 * synthetic button (token c1, c2, …) unless a real control already covers
 * it; act() clicks the element under its box centre.
 */
function promoteClickable(shot, found, viewport) {
  if (!found || !found.length) return shot;
  const area = viewport ? viewport.width * viewport.height : Number.POSITIVE_INFINITY;
  const norm = (text) =>
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  const covered = (b) =>
    shot.elements.some((e) => {
      if (!e.box) return false;
      const cx = b[0] + b[2] / 2;
      const cy = b[1] + b[3] / 2;
      const [x, y, w, h] = e.box;
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    });
  const seen = new Set(shot.elements.map((e) => e.label));
  const added = [];
  for (const item of found) {
    const label = norm(item.t);
    const b = item.b;
    if (
      !label ||
      label.length > 60 ||
      !Array.isArray(b) ||
      b[2] * b[3] > area * MAX_CLICKABLE_SHARE
    )
      continue;
    if (seen.has(label) || covered(b)) continue;
    seen.add(label);
    added.push({
      token: `c${added.length + 1}`,
      role: 'button',
      label,
      kind: 'click',
      region: '',
      box: b,
      synthetic: true,
    });
  }
  if (!added.length) return shot;
  return { ...shot, elements: [...shot.elements, ...added] };
}

/**
 * The page scan's names for repeated controls (page-scan.js), on the
 * snapshot's elements. The scan lists every control of a repeated name in
 * page order, as the snapshot does, so when both count the same number the
 * k-th scanned one is the k-th in the snapshot. That pairing also replaces
 * the snapshot's box: playwright-cli gives all controls of one name the
 * first one's box (all six Drug Wars BUYs at 924,212, so every BUY read
 * 'for "Cocaine"' and the vision marks piled up on one button, 2026-10-02).
 * When the counts differ, a scanned box that contains the element's centre
 * names it.
 */
function applyDisambiguation(elements, items) {
  if (!items || !items.length) return elements;
  const scanned = new Map();
  for (const item of items) {
    if (!scanned.has(item.name)) scanned.set(item.name, []);
    scanned.get(item.name).push(item);
  }
  const listed = new Map();
  for (const e of elements) listed.set(e.label, (listed.get(e.label) || 0) + 1);
  const seen = new Map();
  return elements.map((e) => {
    const same = scanned.get(e.label);
    if (same && same.length === listed.get(e.label)) {
      const k = seen.get(e.label) || 0;
      seen.set(e.label, k + 1);
      const item = same[k];
      // nth: which of the same-named controls it is, for act (page-scan.js pick).
      return {
        ...e,
        nth: k,
        ...(item.b ? { box: item.b } : {}),
        ...(item.ctx && !e.context ? { context: shown(item.ctx) } : {}),
      };
    }
    if (e.context || !e.box) return e;
    const cx = e.box[0] + e.box[2] / 2;
    const cy = e.box[1] + e.box[3] / 2;
    const hits = items.filter(
      ({ b, ctx }) => ctx && cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3]
    );
    if (!hits.length) return e;
    const hit = hits.find((h) => h.name === e.label) || hits[0];
    return { ...e, context: shown(hit.ctx) };
  });
}

/**
 * Controls that share a label (Drug Wars' BUY and MAX in every drug row,
 * Hacker News' "N comments") get the text on their row as context, so the
 * decider can tell them apart. Row = vertical overlap with the control's
 * centre; the nearest text horizontally wins. Needs boxes.
 */
function addRowContext(elements, texts) {
  const count = new Map();
  for (const e of elements) count.set(e.label, (count.get(e.label) || 0) + 1);
  const labels = new Set(elements.map((e) => e.label));
  const candidates = (texts || []).filter((t) => {
    const text = String(t.text).trim();
    return t.box && text.length >= 3 && !/^[\d\s.,+$−-]+$/.test(text) && !labels.has(text);
  });
  // Text nodes often have no box (the snapshot cannot measure them; Drug
  // Wars' "Heroin $6,037", 2026-10-02). Then the row is the nearest text
  // line before the control in snapshot order: each row's label comes
  // before its controls.
  const ordered = (texts || []).filter((t) => {
    const text = String(t.text).trim();
    // A row label is short; a long text is a header or status block (Drug
    // Wars' "CASH $2,000 BANK $0 DEBT ..." line before the first row).
    return (
      typeof t.seq === 'number' &&
      text.length >= 3 &&
      text.length <= 60 &&
      !/^[\d\s.,+$−-]+$/.test(text) &&
      !labels.has(text)
    );
  });
  return elements.map((e) => {
    if ((count.get(e.label) || 0) < 2 || e.context) return e;
    let best = null;
    if (e.box) {
      const cy = e.box[1] + e.box[3] / 2;
      const cx = e.box[0] + e.box[2] / 2;
      for (const t of candidates) {
        const [tx, ty, tw, th] = t.box;
        if (cy < ty - 2 || cy > ty + th + 2) continue;
        const d = Math.abs(tx + tw / 2 - cx);
        if (!best || d < best.d) best = { d, text: String(t.text).replace(/\s+/g, ' ').trim() };
      }
    }
    if (!best && typeof e.seq === 'number') {
      let before = null;
      for (const t of ordered) {
        if (t.seq < e.seq && e.seq - t.seq <= ROW_LOOKBACK) before = t;
        if (t.seq > e.seq) break;
      }
      if (before) best = { text: String(before.text).replace(/\s+/g, ' ').trim() };
    }
    return best ? { ...e, context: shown(best.text) } : e;
  });
}

const ROW_LOOKBACK = 16;

const named = (element) =>
  `${element.role} "${shown(element.label)}"${element.context ? ` for "${element.context}"` : ''}`;

/**
 * Where each element sits relative to the visible part of the page:
 * `in`, `above`, `below`, `aside` (scrolled sideways, a carousel), `hidden`
 * (zero size), or `unknown` (no box: a frame ref, or no viewport known).
 * viewport: { width, height, scrollY, scrollHeight } in CSS pixels.
 */
function place(element, viewport) {
  if (!viewport || !element.box) return 'unknown';
  const [x, y, w, h] = element.box;
  if (w === 0 || h === 0) return 'hidden';
  if (y + h <= 0) return 'above';
  if (y >= viewport.height) return 'below';
  if (x + w <= 0 || x >= viewport.width) return 'aside';
  return 'in';
}

const itemKey = (element) => `${element.role}|${element.label}`;

function countKeys(list, keyOf) {
  const counts = new Map();
  for (const item of list) counts.set(keyOf(item), (counts.get(keyOf(item)) || 0) + 1);
  return counts;
}

// Items of `next` beyond the count `prev` had of the same key, in order.
function surplus(next, prev, keyOf) {
  const budget = countKeys(prev, keyOf);
  const out = [];
  for (const item of next) {
    const left = budget.get(keyOf(item)) || 0;
    if (left > 0) budget.set(keyOf(item), left - 1);
    else out.push(item);
  }
  return out;
}

/**
 * What the last action changed. Refs are renumbered on every snapshot, so
 * elements are matched by role and label (and by count, for repeats).
 * → { url, title, added, removed, changed, texts, scrolled } or null.
 */
function diffShots(prev, next) {
  if (!prev) return null;
  const changed = [];
  const prevByKey = new Map();
  for (const element of prev.elements) {
    const list = prevByKey.get(itemKey(element)) || [];
    list.push(element);
    prevByKey.set(itemKey(element), list);
  }
  const seen = new Map();
  for (const element of next.elements) {
    const key = itemKey(element);
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);
    const before = (prevByKey.get(key) || [])[index];
    if (before && (before.value || '') !== (element.value || '')) {
      changed.push({
        token: element.token,
        role: element.role,
        label: element.label,
        from: before.value || '',
        to: element.value || '',
      });
    }
  }
  const brief = (element) => ({ token: element.token, role: element.role, label: element.label });
  const textKey = (t) => `${t.role}|${t.text}`;
  const prevY = prev.viewport ? prev.viewport.scrollY || 0 : 0;
  const nextY = next.viewport ? next.viewport.scrollY || 0 : 0;
  const added = surplus(next.elements, prev.elements, itemKey).map(brief);
  return {
    url: prev.url !== next.url ? { from: prev.url, to: next.url } : null,
    title: prev.title !== next.title ? { from: prev.title, to: next.title } : null,
    // A navigation or a dialog that covers the page makes most controls
    // new. Marking all of them says nothing; the decider hears that the
    // page was replaced instead.
    replaced: next.elements.length > 10 && added.length > next.elements.length / 2,
    added,
    removed: surplus(prev.elements, next.elements, itemKey).map(brief),
    changed,
    texts: surplus(next.texts || [], prev.texts || [], textKey),
    scrolled: nextY - prevY,
  };
}

const MAX_PAGE_TEXT = 1500;

const MAX_TEXT_ITEM = 300;

const CHROME_REGIONS = new Set(['banner', 'navigation', 'contentinfo']);

function pageTextLines(shot, viewport, max = MAX_PAGE_TEXT) {
  const seen = new Set();
  const visible = [];
  const rest = [];
  for (const t of shot.texts || []) {
    if (CHROME_REGIONS.has(t.region)) continue;
    const full = String(t.text).replace(/\s+/g, ' ').trim();
    const text = full.length > MAX_TEXT_ITEM ? `${full.slice(0, MAX_TEXT_ITEM - 1)}…` : full;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const where = place({ box: t.box }, viewport);
    if (where === 'hidden') continue;
    (where === 'in' || where === 'unknown' ? visible : rest).push(text);
  }
  const lines = [];
  let used = 0;
  for (const text of [...visible, ...rest]) {
    const room = max - used;
    if (room <= 20) break;
    const line = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    lines.push(`  ${line}`);
    used += line.length;
  }
  return lines;
}

module.exports = {
  MAX_LABEL,
  parseSnapshot,
  shown,
  named,
  place,
  promoteClickable,
  applyDisambiguation,
  addRowContext,
  diffShots,
  pageTextLines,
};
