/* Phase 8f: a minimal fake DOM for driving the quick view's REAL close code
   (the GHD-QV-STATE + GHD-QV-OPEN regions of the built panel) without a
   browser. Shared by tests/quickview-close.test.js and the red-evidence
   script. Not a test file itself (no .test.js suffix).

   The one behaviour that matters is copied from Chromium as measured by the
   ghd-qv-test scoop: HTMLDialogElement.close() does NOT dispatch `close`
   synchronously; the event is queued and delivered at the next rendered frame.
   Here that frame is explicit: env.frame() delivers every queued close event.
   Timers are explicit too: env.flush() runs every queued setTimeout. */
function makeEnv() {
  const queuedClose = [];
  const timers = new Map();
  let nextTimer = 1;
  const doc = {};

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.dataset = {};
      this.style = { overflow: '' }; // a real CSSStyleDeclaration reads '' when unset
      this.attrs = {};
      this.listeners = {};
      this.focusable = false;
      this.status = null; // what querySelector('.status[data-qv]') returns
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
    }
    appendChild(c) {
      if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
      c.parent = this;
      this.children.push(c);
      return c;
    }
    set textContent(v) {
      for (const c of this.children) c.parent = null;
      this.children = [];
    }
    get textContent() {
      return '';
    }
    set className(v) {
      this._cls = v;
    }
    get className() {
      return this._cls || '';
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return this.attrs[k] ?? null;
    }
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    dispatch(type, extra) {
      const ev = { type, target: this, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...(extra || {}) };
      for (const f of this.listeners[type] || []) f(ev);
      return ev;
    }
    contains(n) {
      for (let x = n; x; x = x.parent) if (x === this) return true;
      return false;
    }
    matches(sel) {
      if (sel === ':modal') return !!this.modal;
      if (sel.includes('[tabindex]')) return this.focusable;
      return false;
    }
    querySelector() {
      return this.status;
    }
    focus() {
      if (this.focusable || this.tagName === 'BUTTON') doc.activeElement = this;
    }
    blur() {
      if (doc.activeElement === this) doc.activeElement = doc.body;
    }
  }

  class Dialog extends El {
    constructor() {
      super('dialog');
      this.open = false;
      this.modal = false;
    }
    show() {
      this.open = true;
      this.modal = false;
    }
    showModal() {
      this.open = true;
      this.modal = true;
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.modal = false;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
      queuedClose.push(this); // delivered at the next frame, not now
    }
  }

  const html = new El('html');
  const body = new El('body');
  html.appendChild(body);
  Object.assign(doc, {
    documentElement: html,
    body,
    scrollingElement: { scrollTop: 0 },
    activeElement: body,
    listeners: {},
    createElement: (t) => (t === 'dialog' ? new Dialog() : new El(t)),
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    },
    dispatch(type, extra) {
      const ev = { type, target: doc.activeElement, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...(extra || {}) };
      for (const f of this.listeners[type] || []) f(ev);
      return ev;
    },
    contains: (n) => html.contains(n),
    querySelector: () => null,
  });

  const win = { LucideIcons: null };
  const setTimeout_ = (f) => {
    const id = nextTimer++;
    timers.set(id, f);
    return id;
  };
  const clearTimeout_ = (id) => timers.delete(id);

  /** A focusable card description, attached to the page. */
  function opener(name) {
    const card = new El('article');
    const status = new El('p');
    status.focusable = true;
    status.name = name;
    card.status = status;
    card.appendChild(status);
    body.appendChild(card);
    return status;
  }

  function buildQuickView(item) {
    const inner = new El('div');
    const close = new El('button');
    close.name = 'close:' + item.key;
    inner.appendChild(close);
    return { inner, close };
  }

  return {
    doc,
    win,
    html,
    El,
    opener,
    buildQuickView,
    setTimeout: setTimeout_,
    clearTimeout: clearTimeout_,
    frame() {
      let n = 0;
      while (queuedClose.length) {
        queuedClose.shift().dispatch('close');
        n++;
      }
      return n;
    },
    flush() {
      let guard = 0;
      while (timers.size && guard++ < 100) {
        const [id, f] = timers.entries().next().value;
        timers.delete(id);
        f();
      }
    },
    queuedCloseEvents: () => queuedClose.length,
  };
}

/** Evaluate the panel's quick-view code against a fresh fake DOM. */
function loadQuickView(code) {
  const env = makeEnv();
  const api = new Function(
    'document', 'window', 'setTimeout', 'clearTimeout', 'recordKey', 'buildQuickView',
    code +
      `
      return {
        open: openQuickView,
        commit: commitQuickView,
        dialog: quickViewDialog,
        scheduleClose: scheduleQuickViewClose,
        mode: () => QV_MODE,
        locked: () => !!QV_SCROLL_LOCK,
        returnFocus: () => QV_RETURN_FOCUS,
        decisions: {
          close: typeof qvCloseAction === 'function' ? qvCloseAction : null,
          escape: typeof qvEscapeAction === 'function' ? qvEscapeAction : null,
          outside: typeof qvOutsideAction === 'function' ? qvOutsideAction : null,
        },
      };`,
  )(env.doc, env.win, env.setTimeout, env.clearTimeout, (item) => item.key, env.buildQuickView);
  return { env, qv: api };
}

module.exports = { makeEnv, loadQuickView };
