// Runs in the page (webrunner sends `(${scan})()` through playwright-cli
// eval): what the accessibility snapshot cannot tell the decider.
//
// - clickable: elements that act as buttons without a button role (a
//   pointer cursor, an onclick, a tabindex on a non-control, a button-ish
//   class), with their own text and box. Kittens Game's "Gather catnip", A
//   Dark Room's "light fire", Seedship's "New game" (2026-10-02).
//   page.promoteClickable makes them synthetic menu entries.
// - disambiguation: for controls whose name repeats on the page (Drug Wars'
//   BUY in every drug row, "Add to cart" on every product card, Hacker
//   News' "N comments"), a short text that tells them apart, from the
//   DOM itself: what the author attached (aria-describedby, title), the
//   text of the control's row, list item, card, fieldset or form, the
//   distinctive part of a link's URL, or a readable id or name.
//   Each comes with its box: the snapshot gives every control of a repeated
//   name the box of the first (all six Drug Wars BUYs at 924,212,
//   2026-10-02). page.applyDisambiguation pairs them with the snapshot's by
//   order and fixes their boxes.
//
// With `pick` ({ name, nth }), it clicks instead: the nth control (from 0)
// named `name`, counted as above, scrolled into view and focused first. A
// ref cannot reach it: playwright-cli resolves a ref of a repeated name to
// the first control, so every Drug Wars BUY clicked Cocaine's (disabled)
// one, while a click on the right element bought (2026-10-02). Returns
// 'ok' or 'missing'.
//
// Self-contained: no closures, no imports, JSON out.

function scan(pick) {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  // Viewport coordinates, as in the snapshot's boxes. `anywhere` keeps
  // controls scrolled out of view: the menu still lists them (with SCROLL),
  // and Drug Wars' first BUY, scrolled above the fold, fell back to the
  // layout guess and read "for DRUGWARS.ONLINE DAY 1 / 30" (2026-10-02).
  const boxOf = (el, anywhere) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const visible = r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth;
    if (!visible && !anywhere) return null;
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };

  // ── clickable ────────────────────────────────────────────────────────
  // An <a> without href is not a link to the accessibility tree, so only
  // real links and form controls are left to the snapshot.
  const native = /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|OPTION|LABEL)$/;
  const clickable = [];
  for (const el of document.querySelectorAll('body *')) {
    if (clickable.length >= 200) break;
    if (native.test(el.tagName) || (el.tagName === 'A' && el.hasAttribute('href'))) continue;
    if (el.parentElement && el.parentElement.closest('a[href], button')) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    const pointer = getComputedStyle(el).cursor === 'pointer';
    const parentPointer =
      el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer';
    const acts =
      (pointer && !parentPointer) ||
      el.hasAttribute('onclick') ||
      (el.tabIndex >= 0 && el.hasAttribute('tabindex')) ||
      /\b(btn|button|clickable)\b/i.test(cls);
    if (!acts) continue;
    const text = norm(el.innerText || el.getAttribute('aria-label'));
    if (!text || text.length > 60) continue;
    const b = boxOf(el);
    if (b) clickable.push({ t: text, b });
  }

  // ── disambiguation ───────────────────────────────────────────────────
  const CONTROLS =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=radio]';
  const nameOf = (el) =>
    norm(
      el.getAttribute('aria-label') ||
        (el.tagName === 'INPUT' ? el.value || el.placeholder : '') ||
        el.innerText ||
        el.title
    );
  const controls = [];
  for (const el of document.querySelectorAll(CONTROLS)) {
    if (controls.length >= 1000) break;
    const b = boxOf(el, true);
    if (!b) continue;
    const name = nameOf(el);
    if (name) controls.push({ el, name, b });
  }
  if (pick) {
    const target = controls.filter((c) => c.name === pick.name)[pick.nth];
    if (!target) return 'missing';
    target.el.scrollIntoView({ block: 'center' });
    target.el.focus();
    target.el.click();
    return 'ok';
  }
  const counts = new Map();
  for (const c of controls) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  const names = new Set(controls.map((c) => c.name));

  // The first text in `root` that is not inside a control, reads like a
  // label (not a bare number) and is not a control's own name. Text nodes,
  // not innerText lines: table cells join with tabs, which glued "Cocaine
  // $15,236" to its buttons' "MAXBUY".
  const labelIn = (root, name) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest(CONTROLS)) continue;
      const t = norm(n.nodeValue);
      if (t.length < 3 || t.length > 80 || t === name || names.has(t) || /^[\d\s.,+$%−-]+$/.test(t))
        continue;
      return t;
    }
    return '';
  };
  const readable = (v) => /^[a-z][a-z0-9]*([-_ ][a-z0-9]+)+$/i.test(v || '') && /[a-z]{3}/i.test(v);
  const sameNamed = (root, name) =>
    [...root.querySelectorAll(CONTROLS)].filter((x) => nameOf(x) === name).length;
  const MAX_UP = 6;

  const disambiguation = [];
  for (const c of controls) {
    if ((counts.get(c.name) || 0) < 2 || disambiguation.length >= 300) continue;
    const el = c.el;
    let ctx = '';
    // 1. what the author attached
    const described = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .map((id) => id && document.getElementById(id))
      .filter(Boolean)
      .map((n) => norm(n.innerText))
      .join(' ');
    if (described && described !== c.name) ctx = described;
    if (!ctx && el.title && norm(el.title) !== c.name) ctx = norm(el.title);
    // 2. the text of its row, card, fieldset or form: walk up to the last
    // ancestor that holds this control alone under its name (above it is
    // the list of rows), and take its first label-like text.
    if (!ctx) {
      let node = el.parentElement;
      for (
        let up = 0;
        node && node !== document.body && up < MAX_UP;
        up++, node = node.parentElement
      ) {
        if (sameNamed(node, c.name) > 1) break;
        const legend = node.tagName === 'FIELDSET' && node.querySelector('legend');
        ctx = legend ? norm(legend.innerText) : labelIn(node, c.name);
        if (ctx) break;
      }
    }
    // 3. the distinctive part of a link's URL
    if (!ctx && el.tagName === 'A') {
      try {
        const u = new URL(el.href, location.href);
        const tail = u.pathname.split('/').filter(Boolean).pop() || '';
        ctx = norm(`${tail}${u.search}`).slice(0, 60);
      } catch {
        ctx = '';
      }
    }
    // 4. a readable id or name
    if (!ctx) {
      const id = el.id || el.getAttribute('name') || '';
      if (readable(id)) ctx = id;
    }
    // Every repeated control, with or without a name for it, in page order:
    // orient pairs them with the snapshot's by order (see applyDisambiguation).
    disambiguation.push({ name: c.name, b: c.b, ctx: ctx.slice(0, 80) });
  }

  return JSON.stringify({ clickable, disambiguation });
}

// The state of checkable and expandable controls, which slicc's snapshot
// does not print (a checked radio reads like an unchecked one; seen on
// httpbin's pizza size, 2026-10-02): [{ role, name, state }] in page order.
// The name follows the accessible name's usual sources: aria-label, the
// <label>, aria-labelledby, then the text or title.
function states() {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  const SELECTOR =
    'input[type=checkbox], input[type=radio], select, [role=checkbox], [role=radio], [role=switch], [role=tab], [role=option], [role=menuitemcheckbox], [role=menuitemradio], [aria-pressed], [aria-expanded], [aria-selected]';
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'INPUT') return el.type === 'radio' ? 'radio' : 'checkbox';
    if (el.tagName === 'A') return 'link';
    return 'button';
  };
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return norm(label);
    if (el.labels && el.labels.length) return norm(el.labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText)
        .join(' ');
      if (norm(text)) return norm(text);
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.innerText);
    return norm(el.tagName === 'SELECT' ? el.title || el.name : el.innerText || el.title || el.value);
  };
  const out = [];
  // Text fields: what the snapshot leaves out of them, the placeholder, the
  // input type, required, invalid (BU Bench V2.1: four unnamed boxes read
  // `textbox "textbox"`, 2026-10-04). Their name follows the same sources,
  // with the placeholder and title last; an unnamed field is ''.
  const FIELD_ROLE = { search: 'searchbox', number: 'spinbutton' };
  const PLAIN = new Set(['text', 'search', '']);
  const fieldName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return norm(label);
    if (el.labels && el.labels.length) return norm(el.labels[0].innerText);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText)
        .join(' ');
      if (norm(text)) return norm(text);
    }
    return norm(el.getAttribute('placeholder') || el.title);
  };
  const FIELDS = 'textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]):not([type=range]):not([type=color])';
  for (const el of document.querySelectorAll(FIELDS)) {
    if (out.length >= 200) break;
    if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue;
    const type = el.tagName === 'TEXTAREA' ? '' : String(el.getAttribute('type') || '').toLowerCase();
    const parts = [];
    const placeholder = norm(el.getAttribute('placeholder'));
    const name = fieldName(el);
    if (placeholder && placeholder !== name) parts.push(`placeholder "${placeholder.slice(0, 80)}"`);
    if (el.tagName === 'TEXTAREA') parts.push('multi-line');
    else if (!PLAIN.has(type)) parts.push(type);
    if (el.required || el.getAttribute('aria-required') === 'true') parts.push('required');
    if (el.value && el.validity && !el.validity.valid) parts.push('invalid');
    if (el.disabled) parts.push('disabled');
    else if (el.readOnly) parts.push('read-only');
    if (parts.length) out.push({ role: FIELD_ROLE[type] || 'textbox', name, state: parts.join(', ') });
  }
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (out.length >= 400) break;
    const parts = [];
    if (el.tagName === 'SELECT') {
      const chosen = [...el.selectedOptions].map((o) => norm(o.text)).join(', ');
      parts.push(chosen ? `"${chosen}" selected` : 'nothing selected');
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      parts.push(el.checked ? 'checked' : 'not checked');
    } else {
      const checked = el.getAttribute('aria-checked');
      if (checked) parts.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'partly checked' : 'not checked');
      const pressed = el.getAttribute('aria-pressed');
      if (pressed) parts.push(pressed === 'true' ? 'pressed' : 'not pressed');
      const selected = el.getAttribute('aria-selected');
      if (selected === 'true') parts.push('selected');
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) parts.push(expanded === 'true' ? 'expanded' : 'collapsed');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (parts.length) out.push({ role: roleOf(el), name: nameOf(el), state: parts.join(', ') });
  }
  return JSON.stringify(out);
}

// The page's links in page order, for their addresses: slicc's snapshot
// prints no URLs (BU Bench V2.1: listings returned without their links,
// 2026-10-04). [{ name, href }]: the name as the accessible name's usual
// sources give it (aria-label, the text, the title, an image's alt).
function links() {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (out.length >= 3000) break;
    if (!(a.offsetWidth || a.offsetHeight || a.getClientRects().length)) continue;
    const img = a.querySelector('img[alt]');
    const name = norm(a.getAttribute('aria-label')) || norm(a.innerText) || norm(a.textContent) || norm(a.title) || norm(img && img.alt);
    out.push({ name: name.slice(0, 400), href: String(a.href).slice(0, 500) });
  }
  return JSON.stringify(out);
}

// How well a page element's names match a control's accessible name: 3 when
// one of them is the name; 2 when one contains the other and the shorter is
// a real part of it (12+ characters, 40%+ of the longer), spacing aside, or
// when 80%+ of the shorter one's words (4 or more) are in the longer; else 0.
// A link named by all of its content reads differently in the page: its name
// may take a hidden button's label ("Report item …"), its text may hold
// hidden captions, and textContent runs adjacent texts together (product
// cards, BU Bench V2.1, 2026-10-04). Self-contained: it also runs in the
// page, as text.
function nameScore(want, names) {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const words = (s) => s.match(/[\p{L}\p{N}]+/gu) || [];
  const w = norm(want);
  if (!w) return 0;
  const wTight = w.replace(/ /g, '');
  const wWords = words(w);
  let best = 0;
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    if (n === w) return 3;
    const nTight = n.replace(/ /g, '');
    const [short, long] = nTight.length < wTight.length ? [nTight, wTight] : [wTight, nTight];
    if (short.length >= 12 && short.length >= long.length * 0.4 && long.includes(short)) {
      best = 2;
      continue;
    }
    const nWords = words(n);
    const [few, many] = nWords.length < wWords.length ? [nWords, wWords] : [wWords, nWords];
    if (few.length < 4 || few.length < many.length * 0.4) continue;
    const have = new Set(many);
    if (few.filter((x) => have.has(x)).length >= few.length * 0.8) best = 2;
  }
  return best;
}

module.exports = { scan, states, links, nameScore };
