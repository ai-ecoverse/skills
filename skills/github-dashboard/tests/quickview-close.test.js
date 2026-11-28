/* Phase 8f: the quick view's close handling.

   Cuts the GHD-QV-STATE and GHD-QV-OPEN regions out of the BUILT panel and
   drives that real code against tests/qv-fake-dom.js, whose <dialog> queues
   its `close` event to the next frame, as Chromium does. env.frame() is that
   frame. The 8e panel has neither region, so every test here is red against it.

     cd /shared/sprinkles/github-dashboard && tst tests/quickview-close.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/quickview-close.test.js

   NOT a trusted-input test: Escape is a keydown dispatched to the panel's own
   document handler, and the platform's modal Escape (cancel -> close) is
   modelled as dialog.close(). Builtin `tst` runner. */
const fs = require('fs');
const { default: test, is, ok } = require('tst');
const { loadQuickView } = require('./qv-fake-dom.js');

function panelPath() {
  if (process.env.GHD_PANEL) return process.env.GHD_PANEL;
  for (const p of [__dirname + '/../github-dashboard.shtml', __dirname + '/../assets/sprinkle/github-dashboard.shtml']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('github-dashboard.shtml not found; set GHD_PANEL');
}

let SRC = null;
function region(name) {
  SRC = SRC || fs.readFileSync(panelPath(), 'utf8');
  const a = SRC.indexOf(`GHD-${name}:START`);
  const b = SRC.indexOf(`GHD-${name}:END`);
  if (a < 0 || b < 0 || b < a) throw new Error(`panel has no GHD-${name} region`);
  return SRC.slice(SRC.lastIndexOf('/*', a), SRC.lastIndexOf('\n', b));
}
const fresh = () => loadQuickView(region('QV-STATE') + '\n' + region('QV-OPEN'));
const A = { key: 'o/r#1' };
// Focus is compared by NAME: tst serialises a failing value, and a DOM node is circular.
const focusName = (env) => (env.doc.activeElement && env.doc.activeElement.name) || '(body)';
const B = { key: 'o/r#2' };

test('stale close, committed -> committed: the reopened modal keeps its lock and mode', () => {
  const { env, qv } = fresh();
  qv.open(A, env.opener('A'), 'committed');
  is(qv.locked(), true, 'A locked');
  qv.dialog().close('button'); // close event queued, not yet delivered
  qv.open(B, env.opener('B'), 'committed'); // reopened before a frame
  is(env.frame(), 1, 'the late close event is delivered now');
  is(qv.dialog().open, true, 'B still open');
  is(qv.mode(), 'committed', 'QV_MODE still committed');
  is(qv.locked(), true, 'page lock still held');
  is(env.html.style.overflow, 'hidden', 'page still cannot scroll');
});

test('stale close, hover -> committed: the committed modal keeps its lock and mode', () => {
  const { env, qv } = fresh();
  qv.open(A, env.opener('A'), 'hover');
  env.flush();
  qv.dialog().close('pointer left');
  qv.open(B, env.opener('B'), 'committed');
  env.frame();
  is(qv.dialog().open, true);
  is(qv.mode(), 'committed');
  is(qv.locked(), true);
  is(env.html.style.overflow, 'hidden');
});

test('stale close, committed -> hover: a non-modal view never inherits the lock', () => {
  const { env, qv } = fresh();
  qv.open(A, env.opener('A'), 'committed');
  qv.dialog().close('button');
  qv.open(B, env.opener('B'), 'hover');
  env.frame();
  is(qv.dialog().open, true, 'hover view open');
  is(qv.mode(), 'hover', 'mode untouched by the stale event');
  is(qv.locked(), false, 'the ended modal session lock is dropped');
  is(env.html.style.overflow, '', 'page scrolls');
});

test('after a race, the real close still releases everything', () => {
  const { env, qv } = fresh();
  const b = env.opener('B');
  qv.open(A, env.opener('A'), 'committed');
  qv.dialog().close('button');
  qv.open(B, b, 'committed');
  env.frame();
  qv.dialog().close('button');
  env.frame();
  env.flush();
  is(qv.dialog().open, false);
  is(qv.mode(), null, 'mode reset');
  is(qv.locked(), false, 'lock released');
  is(env.html.style.overflow, '', 'overflow restored');
  is(focusName(env), b.name, 'focus back on the card that opened B');
});

test('every close path, without a race, releases the lock and resets the mode', () => {
  const paths = {
    'close button': (d) => d.close('button'),
    'backdrop click': (d) => d.dispatch('click'), // target === dialog
    'platform Escape (cancel -> close), modelled': (d) => d.close('escape'),
  };
  for (const [name, act] of Object.entries(paths)) {
    const { env, qv } = fresh();
    const s = env.opener('A');
    qv.open(A, s, 'committed');
    act(qv.dialog());
    env.frame();
    env.flush();
    is(qv.dialog().open, false, name + ': closed');
    is(qv.mode(), null, name + ': mode reset');
    is(qv.locked(), false, name + ': lock released');
    is(focusName(env), s.name, name + ': focus returned');
  }
  // the hover grace timer
  const { env, qv } = fresh();
  qv.open(A, env.opener('A'), 'hover');
  env.flush();
  qv.scheduleClose('pointer left the quick view');
  env.flush();
  env.frame();
  is(qv.dialog().open, false, 'grace timer: closed');
  is(qv.mode(), null, 'grace timer: mode reset');
});

test('Escape closes a PROMOTED view and returns focus to the card that opened it', () => {
  const { env, qv } = fresh();
  const s = env.opener('A');
  s.focus();
  qv.open(A, s, 'hover');
  env.flush();
  qv.commit(); // a click inside the view, or on its card
  is(qv.mode(), 'committed', 'promoted');
  is(qv.dialog().modal, false, 'still non-modal');
  qv.dialog().children[0].children[0].focus(); // keyboard inside the view
  const ev = env.doc.dispatch('keydown', { key: 'Escape' });
  is(ev.defaultPrevented, true, 'handled');
  is(qv.dialog().open, false, 'closed');
  env.frame();
  env.flush();
  is(qv.mode(), null);
  is(focusName(env), s.name, 'focus on the opening card description');
});

test('a PROMOTED view closed by its close button also returns focus to its card', () => {
  const { env, qv } = fresh();
  const s = env.opener('A');
  qv.open(A, s, 'hover');
  env.flush();
  qv.commit();
  const closeBtn = qv.dialog().children[0].children[0];
  closeBtn.focus();
  qv.dialog().close('button');
  env.frame();
  env.flush();
  is(focusName(env), 'A', 'focus on the opening card description');
});

test('Escape on a promoted view does not steal focus from the page behind it', () => {
  const { env, qv } = fresh();
  const s = env.opener('A');
  const elsewhere = env.opener('filter');
  qv.open(A, s, 'hover');
  env.flush();
  qv.commit();
  elsewhere.focus(); // the page behind is live: the user tabbed out
  env.doc.dispatch('keydown', { key: 'Escape' });
  env.frame();
  env.flush();
  is(qv.dialog().open, false, 'closed');
  is(focusName(env), elsewhere.name, 'focus left where the user put it');
});

test('Escape leaves a MODAL view to the platform, and still closes a hover view', () => {
  const m = fresh();
  m.qv.open(A, m.env.opener('A'), 'committed');
  const ev = m.env.doc.dispatch('keydown', { key: 'Escape' });
  is(ev.defaultPrevented, false, 'modal: not intercepted');
  is(m.qv.dialog().open, true, 'modal: the panel does not close it itself');
  const h = fresh();
  h.qv.open(A, h.env.opener('A'), 'hover');
  h.env.flush();
  h.env.doc.dispatch('keydown', { key: 'Escape' });
  is(h.qv.dialog().open, false, 'hover: closed');
});

test('an outside press closes a hover view but NOT a promoted one', () => {
  const h = fresh();
  h.qv.open(A, h.env.opener('A'), 'hover');
  h.env.flush();
  h.env.doc.dispatch('mousedown', { target: h.env.opener('page') });
  is(h.qv.dialog().open, false, 'hover closed by an outside press');
  const p = fresh();
  p.qv.open(A, p.env.opener('A'), 'hover');
  p.env.flush();
  p.qv.commit();
  p.env.doc.dispatch('mousedown', { target: p.env.opener('page') });
  is(p.qv.dialog().open, true, 'promoted view stays open');
  is(p.qv.mode(), 'committed');
});

test('decision table: a stale close touches nothing the open view owns', () => {
  const { qv } = fresh();
  const c = qv.decisions.close;
  ok(c, 'qvCloseAction exists');
  is(JSON.stringify(c({ open: true, modal: true })), JSON.stringify({ stale: true, unlock: false, resetMode: false, restoreFocus: false }));
  is(JSON.stringify(c({ open: true, modal: false })), JSON.stringify({ stale: true, unlock: true, resetMode: false, restoreFocus: false }));
  is(JSON.stringify(c({ open: false, modal: false })), JSON.stringify({ stale: false, unlock: true, resetMode: true, restoreFocus: true }));
});
