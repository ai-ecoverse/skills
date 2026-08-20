// signal.jsh — Signal Desktop CLI for SLICC
//
// Automates the Signal Desktop Electron app via its CDP target
// (file:///.../Signal.app/.../background.html). There is no public HTTP API
// for personal Signal Desktop; all operations go through playwright-cli
// against the live app tab (DOM + a11y). Internals (Redux / ConversationController
// / sqlcipher) are not exposed on window.
//
// Usage:
//   signal tabs | status
//   signal chats | list [--json] [--unread]
//   signal search <query> [--json]
//   signal open <name|id>
//   signal read [name|id] [--limit=N] [--json]
//   signal send <name|id> <text> --yes          # refuses without --yes
//   signal send <name|id> <text> --draft        # fill composer only, do not send
//   signal watch <name|id> --scoop=<name>       # lick a scoop only on change (poller)
//   signal watches | unwatch <id|all> | watch-poll | reinject
//   signal help
//
// Setup: the `signal` command is auto-discovered from this skill script. If a
// fresh catalog is needed, touch the script (never /usr/bin/signal — an empty
// file there shadows the command and breaks it):
//   touch /workspace/skills/signal/scripts/signal.jsh; hash -r
//
// Safety: send requires --yes. Never auto-send. Do not dump full histories into
// scoop notifications — summarize.

const { exec } = require('sliccy:exec');
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const fs = require('fs');

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const { positional: _pos, flags } = process.argv.parseFlags();
const subcommand = (_pos[0] || '').toLowerCase();
const positional = _pos.slice(1);

if (!subcommand || subcommand === 'help' || flags.help || flags.h) {
  cli.help(usageText());
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function sleep(ms) {
  return Promise.resolve();
}

// Strip Signal bidi isolates (U+2068 FIRST-STRONG ISOLATE / U+2069 POP) and
// collapse whitespace.
function cleanText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Tab discovery ───────────────────────────────────────────────────────────
//
// Signal Desktop appears as a tray remote CDP target:
//   [runtimeId:pageId] file:///Applications/Signal.app/.../background.html "Signal (N)" [remote:runtimeId]
// The composite id (runtimeId:pageId) is what playwright-cli --tab= expects.

let _tabId = null;

async function tabListRaw() {
  const r = await exec('playwright-cli tab-list');
  if (r.exitCode !== 0) {
    throw new Error('playwright-cli tab-list failed: ' + (r.stderr || r.stdout || ''));
  }
  return r.stdout || '';
}

function parseSignalTabs(stdout) {
  const lines = stdout.split('\n');
  const found = [];
  for (const line of lines) {
    // Match composite or bare ids; prefer Signal.app / background.html / title Signal
    const idMatch = line.match(/^\[([^\]]+)\]\s+(\S+)\s+"(.*)"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const url = idMatch[2];
    const title = idMatch[3] || '';
    const remoteMatch = line.match(/\[remote:([^\]]+)\]/);
    const isSignal =
      /Signal\.app/i.test(url) ||
      /background\.html/i.test(url) ||
      /^Signal(\s|\(|$)/i.test(title) ||
      /\/Signal\.app\//i.test(line);
    if (!isSignal) continue;
    found.push({
      id,
      url,
      title,
      remote: remoteMatch ? remoteMatch[1] : null,
      line: line.trim(),
    });
  }
  return found;
}

async function findSignalTab({ fatal = true } = {}) {
  if (_tabId) return _tabId;
  let _t = null;
  try { _t = await browser.findTab({ urlMatch: /background\.html|Signal\.app/i }); } catch (e) { _t = null; }
  if (_t && _t.targetId) { _tabId = _t.targetId; return _tabId; }
  const raw = await tabListRaw();
  const tabs = parseSignalTabs(raw);
  if (!tabs.length) {
    if (!fatal) return null;
    cli.die(
      'No Signal Desktop tab found.\n' +
        'Open Signal Desktop on the host (tray remote must expose CDP).\n' +
        'Re-check with: playwright-cli tab-list | rg -i signal',
      { prefix: 'signal' }
    );
  }
  // Prefer a tab whose title still says Signal (app is alive)
  const preferred =
    tabs.find((t) => /^Signal/i.test(t.title)) || tabs[0];
  _tabId = preferred.id;
  return _tabId;
}

// ─── playwright-cli wrappers with CDP retry ──────────────────────────────────
// Remote Electron CDP occasionally times out on Runtime.enable. Retry a few
// times before giving up.

async function withRetry(fn, { attempts = 5, delayMs = 1500, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const retryable = /timed out|Runtime\.enable|Target closed|WebSocket/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

async function pw(argsArray) {
  const tabId = await findSignalTab();
  const cmd =
    'playwright-cli ' +
    argsArray
      .map((a) => escapeShellArg(a))
      .join(' ') +
    ' --tab=' +
    escapeShellArg(tabId);
  const r = await exec(cmd);
  if (r.exitCode !== 0) {
    const err = (r.stderr || r.stdout || 'playwright-cli failed').trim();
    const e = new Error(err);
    e.stdout = r.stdout;
    e.stderr = r.stderr;
    e.exitCode = r.exitCode;
    throw e;
  }
  return (r.stdout || '').replace(/\n$/, '');
}

// Evaluate JS in the Signal tab. Prefer sliccy:browser (no temp files / no
// shell-quoting). Fall back to playwright-cli eval for large expressions if
// the browser bridge rejects the composite remote id.
async function pwEval(expression) {
  return withRetry(async () => {
    const tabId = await findSignalTab();
    const expr = String(expression).trim();

    // 1) browser.evalAsync — accepts bare targetId strings
    try {
      const raw = await browser.evalAsync(tabId, expr);
      if (raw !== undefined && raw !== null) {
        return typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // Fall through to playwright-cli on bridge/tab mismatch
      if (!/not found|unknown tab|no tab|ENOTDIR|timed out|Runtime\.enable/i.test(msg)) {
        // still try playwright path below
      }
    }

    // 2) playwright-cli eval (inline). Collapse newlines so the shell arg is one line.
    const collapsed = expr.replace(/\s*\n\s*/g, ' ');
    const r = await exec(
      'playwright-cli eval --tab=' +
        escapeShellArg(tabId) +
        ' ' +
        escapeShellArg(collapsed)
    );
    if (r.exitCode !== 0) {
      throw new Error((r.stderr || r.stdout || 'eval failed').trim());
    }
    return (r.stdout || '').replace(/\n$/, '');
  }, { label: 'eval' });
}

async function pwEvalJson(expression) {
  const raw = await pwEval(expression);
  let data = raw;
  // Unwrap up to two layers of JSON encoding
  for (let i = 0; i < 2; i++) {
    if (typeof data !== 'string') break;
    const t = data.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[' && t[0] !== '"' && t !== 'true' && t !== 'false' && t !== 'null' && !/^-?\d/.test(t))) {
      break;
    }
    try {
      data = JSON.parse(t);
    } catch (e) {
      break;
    }
  }
  if (typeof data === 'string') {
    // Last resort: expression forgot to JSON.stringify
    throw new Error('Failed to parse eval JSON: ' + String(raw).slice(0, 300));
  }
  return data;
}

async function pwClick(ref) {
  return withRetry(() => pw(['click', ref]), { label: 'click' });
}

async function pwType(text) {
  return withRetry(() => pw(['type', text]), { label: 'type' });
}

async function pwPress(key) {
  return withRetry(() => pw(['press', key]), { label: 'press' });
}

async function pwSnapshot() {
  return withRetry(() => pw(['snapshot']), { label: 'snapshot' });
}

// ─── In-page scrapers (injected as source strings) ───────────────────────────

const SRC_LIST_CHATS = `
(() => {
  function clean(s) {
    return String(s || '').replace(/[\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
  }
  const buttons = [...document.querySelectorAll(
    'button.module-conversation-list__item--contact-or-conversation'
  )];
  const chats = buttons.map((b) => {
    const nameEl = b.querySelector(
      '.module-conversation-list__item--contact-or-conversation__content__header__name__contact-name, .module-contact-name'
    );
    const dateEl = b.querySelector(
      '.module-conversation-list__item--contact-or-conversation__content__header__date'
    );
    const msgEl = b.querySelector(
      '.module-conversation-list__item--contact-or-conversation__content__message__text'
    );
    const aria = b.getAttribute('aria-label') || '';
    let unread = 0;
    const m = aria.match(/(\\d+)\\s+new messages/);
    if (m) unread = parseInt(m[1], 10);
    const selected =
      b.className.includes('selected') ||
      b.getAttribute('aria-selected') === 'true' ||
      b.hasAttribute('data-selected');
    return {
      id: b.getAttribute('data-id') || null,
      serviceId: b.getAttribute('data-testid') || null,
      name: clean(nameEl ? nameEl.textContent : ''),
      time: clean(dateEl ? dateEl.textContent : ''),
      preview: clean(msgEl ? msgEl.textContent : '').slice(0, 160),
      unread,
      selected: !!selected,
    };
  });
  // Unread badge on Chats tab
  let totalUnread = null;
  const badge = document.querySelector(
    '[data-testid="NavTabsItem--Chats"] .NavTabs__ItemIconLabel, .NavTabs__Item--Chats .NavTabs__ItemIconLabel'
  );
  if (badge) {
    const n = parseInt(clean(badge.textContent).replace(/\\D+/g, ''), 10);
    if (!isNaN(n)) totalUnread = n;
  }
  return JSON.stringify({
    ok: true,
    count: chats.length,
    totalUnread,
    title: document.title,
    chats,
  });
})()
`;

const SRC_OPEN_CHAT = (query) => `
(() => {
  function clean(s) {
    return String(s || '').replace(/[\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
  }
  const q = ${JSON.stringify(query)};
  const qLower = q.toLowerCase();
  const buttons = [...document.querySelectorAll(
    'button.module-conversation-list__item--contact-or-conversation'
  )];
  function meta(b) {
    const nameEl = b.querySelector(
      '.module-conversation-list__item--contact-or-conversation__content__header__name__contact-name, .module-contact-name'
    );
    return {
      id: b.getAttribute('data-id') || '',
      serviceId: b.getAttribute('data-testid') || '',
      name: clean(nameEl ? nameEl.textContent : ''),
      aria: clean(b.getAttribute('aria-label') || ''),
    };
  }
  let btn = null;
  // Exact id / serviceId
  btn = buttons.find((b) => {
    const m = meta(b);
    return m.id === q || m.serviceId === q;
  });
  // Exact name (case-insensitive). Distinct conversations can share a display
  // name, so report that as ambiguous instead of silently taking the first row.
  if (!btn) {
    const exact = buttons.filter((b) => meta(b).name.toLowerCase() === qLower);
    if (exact.length === 1) btn = exact[0];
    else if (exact.length > 1) {
      return JSON.stringify({
        ok: false,
        error: 'ambiguous',
        matches: exact.slice(0, 8).map((b) => meta(b)),
      });
    }
  }
  // Substring name
  if (!btn) {
    const hits = buttons.filter((b) => meta(b).name.toLowerCase().includes(qLower));
    if (hits.length === 1) btn = hits[0];
    else if (hits.length > 1) {
      return JSON.stringify({
        ok: false,
        error: 'ambiguous',
        matches: hits.slice(0, 8).map((b) => meta(b)),
      });
    }
  }
  if (!btn) {
    return JSON.stringify({
      ok: false,
      error: 'not_found',
      query: q,
      available: buttons.slice(0, 30).map((b) => meta(b).name),
    });
  }
  btn.focus();
  btn.click();
  return JSON.stringify({ ok: true, opened: meta(btn) });
})()
`;

// Report which conversation is actually rendered, keyed on a STABLE identity.
// The header title is not an identity: two conversations can share a display
// name, so a still-mounted previous chat can satisfy a title-only check. The
// left pane marks the selected row and that row carries the conversation's
// stable ids (data-id / data-testid), which is the identity to compare.
const SRC_CONFIRM_OPEN = (wantTitle) => `
(() => {
  function clean(s) {
    return String(s || '').replace(/[\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
  }
  const want = ${JSON.stringify(String(wantTitle || ''))};
  const rows = [...document.querySelectorAll(
    'button.module-conversation-list__item--contact-or-conversation'
  )];
  function nameOf(b) {
    const nameEl = b.querySelector(
      '.module-conversation-list__item--contact-or-conversation__content__header__name__contact-name, .module-contact-name'
    );
    return clean(nameEl ? nameEl.textContent : '');
  }
  const selected = rows.filter((b) =>
    b.className.includes('selected') ||
    b.getAttribute('aria-selected') === 'true' ||
    b.hasAttribute('data-selected')
  );
  const only = selected.length === 1 ? selected[0] : null;
  const header = document.querySelector('.module-ConversationHeader__header__info__title');
  return JSON.stringify({
    hasView: !!document.querySelector('.ConversationView, .module-timeline'),
    title: header ? clean(header.textContent) : null,
    selectedId: only ? (only.getAttribute('data-id') || '') : '',
    selectedServiceId: only ? (only.getAttribute('data-testid') || '') : '',
    titleMatches: want ? rows.filter((b) => nameOf(b) === want).length : 0,
  });
})()
`;

const SRC_READ_MESSAGES = (limit) => `
(() => {
  function clean(s) {
    return String(s || '').replace(/[\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
  }
  const limit = ${Number(limit) || 30};
  const header = document.querySelector('.module-ConversationHeader__header__info__title');
  const title = header ? clean(header.textContent) : null;
  if (!document.querySelector('.ConversationView, .module-timeline')) {
    return JSON.stringify({ ok: false, error: 'no_open_chat', title });
  }
  const nodes = [...document.querySelectorAll('.module-message')];
  const msgs = nodes.map((m) => {
    const incoming = m.classList.contains('module-message--incoming');
    const outgoing = m.classList.contains('module-message--outgoing');
    const authorEl = m.querySelector('.module-message__author');
    const textEl = m.querySelector('.module-message__text');
    const dateEl = m.querySelector('.module-message__metadata__date');
    let time = null;
    if (dateEl) {
      time =
        dateEl.getAttribute('datetime') ||
        dateEl.getAttribute('title') ||
        clean(dateEl.textContent) ||
        null;
    }
    const wrap = m.closest('.module-message__wrapper') || m;
    const labelled = wrap.getAttribute('aria-labelledby') || '';
    // Prefer accessible full text when bubble text is empty (stickers, deletes)
    let text = textEl ? clean(textEl.textContent) : '';
    if (!text && labelled) {
      const acc = document.getElementById(labelled);
      if (acc) text = clean(acc.textContent).slice(0, 400);
    }
    const hasAttach = !!m.querySelector(
      '.module-message__attachment-container, [class*="attachment"], img.module-image__image'
    );
    return {
      direction: outgoing ? 'out' : incoming ? 'in' : '?',
      author: authorEl ? clean(authorEl.textContent) : outgoing ? 'You' : null,
      text: text || null,
      time,
      attachment: hasAttach,
      id: m.getAttribute('data-testid') || null,
    };
  });
  // Return the last N
  const sliced = msgs.slice(-limit);
  return JSON.stringify({
    ok: true,
    title,
    count: sliced.length,
    totalRendered: msgs.length,
    messages: sliced,
  });
})()
`;

const SRC_ENSURE_CHATS_TAB = `
(() => {
  const chatsTab = document.querySelector('[data-testid="NavTabsItem--Chats"]');
  if (chatsTab && chatsTab.getAttribute('aria-selected') !== 'true') {
    chatsTab.click();
    return JSON.stringify({ ok: true, switched: true });
  }
  return JSON.stringify({ ok: true, switched: false });
})()
`;

const SRC_COMPOSER_STATE = `
(() => {
  const editor = document.querySelector('.ql-editor');
  const header = document.querySelector('.module-ConversationHeader__header__info__title');
  function clean(s) {
    return String(s || '').replace(/[\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
  }
  return JSON.stringify({
    ok: !!editor,
    title: header ? clean(header.textContent) : null,
    content: editor ? clean(editor.textContent) : null,
    isBlank: editor ? editor.classList.contains('ql-blank') : null,
  });
})()
`;

const SRC_FOCUS_COMPOSER = `
(() => {
  const editor = document.querySelector('.ql-editor');
  if (!editor) return JSON.stringify({ ok: false, error: 'no_composer' });
  editor.focus();
  // Place caret at end
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return JSON.stringify({ ok: true });
})()
`;

const SRC_CLEAR_COMPOSER = `
(() => {
  const editor = document.querySelector('.ql-editor');
  if (!editor) return JSON.stringify({ ok: false, error: 'no_composer' });
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  try { document.execCommand('delete'); } catch (e) {}
  editor.innerHTML = '<div dir="auto"><br></div>';
  editor.classList.add('ql-blank');
  try {
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  } catch (e) {}
  return JSON.stringify({ ok: true, content: editor.textContent });
})()
`;

const SRC_INSERT_TEXT = (text) => `
(() => {
  const editor = document.querySelector('.ql-editor');
  if (!editor) return JSON.stringify({ ok: false, error: 'no_composer' });
  editor.focus();
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(r);
  try { document.execCommand('delete'); } catch (e) {}
  const text = ${JSON.stringify(String(text))};
  document.execCommand('insertText', false, text);
  try {
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } catch (e) {}
  return JSON.stringify({ ok: true, content: editor.textContent });
})()
`;

const SRC_PRESS_ENTER = `
(() => {
  const editor = document.querySelector('.ql-editor');
  if (!editor) return JSON.stringify({ ok: false, error: 'no_composer' });
  editor.focus();
  function fire(type) {
    const ev = new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    return editor.dispatchEvent(ev);
  }
  const kd = fire('keydown');
  fire('keypress');
  fire('keyup');
  return JSON.stringify({ ok: true, keydownNotCancelled: kd });
})()
`;

// ─── Higher-level ops ────────────────────────────────────────────────────────

async function ensureChatsTab() {
  await pwEvalJson(SRC_ENSURE_CHATS_TAB);
  await sleep(200);
}

async function listChats() {
  await ensureChatsTab();
  return pwEvalJson(SRC_LIST_CHATS);
}

async function openChat(query) {
  await ensureChatsTab();
  const res = await pwEvalJson(SRC_OPEN_CHAT(query));
  if (!res.ok) return res;
  // Wait until the conversation we clicked is the one actually RENDERED — not
  // merely that a ConversationView is mounted, and not merely that the header
  // title matches. When switching from another chat the previous view stays
  // mounted while the new one loads (and sleep() is a no-op here), and two
  // conversations can share a display title, so a title-only check can confirm
  // the wrong chat. Confirm on the stable conversation id of the selected
  // left-pane row wherever Signal exposes it, and fall back to the title only
  // when that title is unique among visible rows. Each poll is a real eval
  // round-trip, which provides the wait.
  const wantId = String((res.opened && res.opened.id) || '');
  const wantServiceId = String((res.opened && res.opened.serviceId) || '');
  const wantTitle = cleanText(res.opened && res.opened.name);
  res.confirmed = false;
  for (let i = 0; i < 20; i++) {
    const state = await pwEvalJson(SRC_CONFIRM_OPEN(wantTitle));
    if (!state || !state.hasView) continue;
    if (wantTitle && cleanText(state.title) !== wantTitle) continue;
    const haveId = String(state.selectedId || '');
    const haveServiceId = String(state.selectedServiceId || '');
    if ((wantId && haveId) || (wantServiceId && haveServiceId)) {
      // Stable identity is readable — it must be the row we clicked.
      if ((wantId && haveId === wantId) || (wantServiceId && haveServiceId === wantServiceId)) {
        res.confirmed = true;
        break;
      }
      res.confirmDetail = 'another conversation is still selected in the chat list';
      continue;
    }
    if ((state.titleMatches || 0) > 1) {
      // Duplicate display titles and no readable selected-row id: refuse to
      // guess which of them is open.
      res.confirmDetail =
        state.titleMatches + ' visible conversations share the title "' + wantTitle +
        '" and no selected-row id is exposed to tell them apart';
      continue;
    }
    res.confirmed = true;
    break;
  }
  return res;
}

async function readMessages(limit) {
  return pwEvalJson(SRC_READ_MESSAGES(limit));
}

function matchChats(chats, query) {
  const q = cleanText(query).toLowerCase();
  if (!q) return chats;
  return chats.filter((c) => {
    const hay = [c.name, c.preview, c.id, c.serviceId].map((x) => cleanText(x).toLowerCase()).join(' ');
    return hay.includes(q);
  });
}

async function resolveOpenTarget(nameOrId) {
  if (!nameOrId) {
    // Use currently open chat
    const state = await pwEvalJson(SRC_COMPOSER_STATE);
    if (state && state.title) return { ok: true, opened: { name: state.title } };
    return { ok: false, error: 'no_open_chat' };
  }
  return openChat(nameOrId);
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function printChatsTable(chats) {
  if (!chats.length) {
    console.log('(no chats visible in the left pane)');
    return;
  }
  const rows = [
    ['UNREAD', 'TIME', 'NAME', 'PREVIEW'],
    ...chats.map((c) => [
      c.unread ? String(c.unread) : '',
      c.time || '',
      c.name || '',
      (c.preview || '').slice(0, 60),
    ]),
  ];
  console.log(fmt.table(rows, [6, 12, 24, 60]));
}

function printMessages(data) {
  console.log('Chat: ' + (data.title || '(unknown)'));
  console.log('Showing ' + data.count + ' of ' + data.totalRendered + ' rendered messages');
  console.log('---');
  for (const m of data.messages || []) {
    const who = m.direction === 'out' ? 'You' : m.author || 'Them';
    const when = m.time ? '  ' + m.time : '';
    const attach = m.attachment ? ' [attachment]' : '';
    const body = m.text || (m.attachment ? '(attachment)' : '(empty)');
    console.log('[' + (m.direction || '?') + '] ' + who + when + attach);
    console.log('  ' + body);
  }
}

function usageText() {
  return `signal — Signal Desktop CLI (CDP / DOM automation)

Setup: auto-discovered from the skill script. For a catalog refresh only:
  touch /workspace/skills/signal/scripts/signal.jsh; hash -r
  (never touch /usr/bin/signal — an empty file there shadows the command)

Requires Signal Desktop running on a tray host with CDP exposed.
Find the tab:  signal tabs

Commands:
  signal tabs | status              Find live Signal CDP tab(s)
  signal chats | list [--json] [--unread]
                                    List conversations in the left pane
  signal search <query> [--json]    Filter chats by name/preview
  signal open <name|id>             Open a conversation
  signal read [name|id] [--limit=N] [--json]
                                    Read recent messages (opens chat if named)
  signal send <name|id> <text> --yes
                                    Send a message (REFUSES without --yes)
  signal send <name|id> <text> --draft
                                    Fill the composer only; do not press Send/Enter
  signal watch <name|id> --scoop=<name> [--every=<minutes>] [--force]
                                    Lick a scoop when (and only when) a chat changes
  signal watches [--json]           List active watches
  signal unwatch <watch-id|all>     Stop watching
  signal watch-poll [--json]        Run one poll pass (invoked by the poller scoop)
  signal reinject                   Re-ensure the poll crontask for stored watches
  signal help                       This help

Safety:
  - Default is read-only.
  - \`send\` requires --yes. Prefer --draft to validate composer fill.
  - Do not exfiltrate full message history into notifications; summarize.
  - Do not change Signal account settings.

Watching:
  Signal has no push and no readable socket (E2E), so change detection polls.
  One crontask licks the poller scoop "signal-watch" at the SMALLEST --every of
  all watches; it runs \`signal watch-poll\`, which reads the left-pane chat LIST
  once (reliable browser bridge — no chat switching, no leader attach), skips any
  watch not yet due for its own --every, and calls a watch's webhook ONLY when
  its row changed. A row missing from the virtualized pane is skipped, not
  reported. Setup once: a scoop named "signal-watch" that runs
  \`signal watch-poll\` on each "signal-watch-poll" lick. Fingerprint (unread +
  last-message preview) stays local; the lick payload is metadata only (plus the
  conversation id, so the woken scoop reads the right chat).
  Reads the list, so it observes background chats regardless of what is open.

Notes:
  - Only chats currently rendered in the virtualized left pane are listed
    (typically the most recent ~15-30). Scroll the pane in the UI for older ones,
    or use search once a UI search path is driven.
  - Remote CDP can time out; the CLI retries Runtime.enable failures.
  - Refresh a dead tab id: playwright-cli tab-list | rg -i signal
`;
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function cmdTabs() {
  const raw = await tabListRaw();
  const tabs = parseSignalTabs(raw);
  if (flags.json) {
    cli.out({ ok: true, count: tabs.length, tabs });
    return;
  }
  if (!tabs.length) {
    console.log('No Signal Desktop tabs found.');
    console.log('Open Signal.app on the tray host and retry.');
    process.exit(1);
  }
  for (const t of tabs) {
    console.log(t.id);
    console.log('  url:    ' + t.url);
    console.log('  title:  ' + t.title);
    if (t.remote) console.log('  remote: ' + t.remote);
  }
  // Also probe liveness
  _tabId = tabs[0].id;
  try {
    const title = await withRetry(() => pw(['eval', 'document.title']), { attempts: 3 });
    console.log('  live:   yes (' + title + ')');
  } catch (e) {
    console.log('  live:   no (' + String(e.message || e).slice(0, 120) + ')');
  }
}

async function cmdChats() {
  const data = await listChats();
  if (!data.ok) cli.die(data.error || 'list failed', { prefix: 'signal' });
  let chats = data.chats || [];
  if (flags.unread) chats = chats.filter((c) => c.unread > 0);
  if (flags.json) {
    cli.out({ ok: true, count: chats.length, totalUnread: data.totalUnread, title: data.title, chats });
    return;
  }
  if (data.totalUnread != null) {
    console.log('Title: ' + data.title + '  |  tab unread badge: ' + data.totalUnread);
  } else {
    console.log('Title: ' + data.title);
  }
  printChatsTable(chats);
}

async function cmdSearch() {
  const q = positional.join(' ').trim();
  if (!q) cli.die('usage: signal search <query>', { prefix: 'signal' });
  const data = await listChats();
  const hits = matchChats(data.chats || [], q);
  if (flags.json) {
    cli.out({ ok: true, query: q, count: hits.length, chats: hits });
    return;
  }
  console.log('Search: ' + q + '  (' + hits.length + ' hits)');
  printChatsTable(hits);
}

async function cmdOpen() {
  const q = positional.join(' ').trim();
  if (!q) cli.die('usage: signal open <name|id>', { prefix: 'signal' });
  const res = await openChat(q);
  if (!res.ok) {
    if (res.error === 'ambiguous') {
      console.error('Ambiguous match for "' + q + '":');
      for (const m of res.matches || []) console.error('  - ' + m.name + '  (' + m.id + ')');
      process.exit(1);
    }
    if (res.error === 'not_found') {
      console.error('No chat matching "' + q + '".');
      if (res.available && res.available.length) {
        console.error('Visible chats: ' + res.available.join(', '));
      }
      process.exit(1);
    }
    cli.die(res.error || 'open failed', { prefix: 'signal' });
  }
  if (flags.json) cli.out(res);
  else console.log('Opened: ' + (res.opened && res.opened.name) + '  id=' + (res.opened && res.opened.id));
}

async function cmdRead() {
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
  const q = positional.join(' ').trim();
  if (q) {
    const res = await openChat(q);
    if (!res.ok) {
      if (res.error === 'ambiguous') {
        console.error('Ambiguous match — pass one of these ids instead:');
        for (const m of res.matches || []) console.error('  - ' + m.name + '  (' + m.id + ')');
        process.exit(1);
      }
      cli.die(res.error === 'not_found' ? 'Chat not found: ' + q : res.error || 'open failed', {
        prefix: 'signal',
      });
    }
    if (res.confirmed === false) {
      cli.die(
        'could not confirm "' + q + '" is the open conversation — aborting so this ' +
          'does not return messages from another chat' +
          (res.confirmDetail ? ' (' + res.confirmDetail + ')' : '') +
          '. Retry, or: signal open ' + JSON.stringify(q),
        { prefix: 'signal' }
      );
    }
    await sleep(400);
  }
  const data = await readMessages(limit);
  if (!data.ok) {
    cli.die(
      data.error === 'no_open_chat'
        ? 'No chat open. Pass a name: signal read "Weekend Hikers"'
        : data.error || 'read failed',
      { prefix: 'signal' }
    );
  }
  if (flags.json) cli.out(data);
  else printMessages(data);
}

async function cmdSend() {
  // signal send <name|id> <text...> --yes|--draft
  if (positional.length < 2) {
    cli.die('usage: signal send <name|id> <text> --yes   (or --draft)', { prefix: 'signal' });
  }
  const target = positional[0];
  const text = positional.slice(1).join(' ');
  if (!text) cli.die('message text is empty', { prefix: 'signal' });

  const draftOnly = !!(flags.draft || flags['dry-run'] || flags.dryrun);
  const yes = !!(flags.yes || flags.y);

  if (!draftOnly && !yes) {
    cli.die(
      'refusing to send without --yes\n' +
        '  Draft only:  signal send ' +
        JSON.stringify(target) +
        ' ' +
        JSON.stringify(text) +
        ' --draft\n' +
        '  Really send: signal send ' +
        JSON.stringify(target) +
        ' ' +
        JSON.stringify(text) +
        ' --yes',
      { prefix: 'signal' }
    );
  }

  const opened = await openChat(target);
  if (!opened.ok) {
    cli.die(
      opened.error === 'not_found'
        ? 'Chat not found: ' + target
        : opened.error === 'ambiguous'
          ? 'Ambiguous chat name — pass the conversation id (signal chats --json)'
          : opened.error || 'open failed',
      { prefix: 'signal' }
    );
  }
  if (opened.confirmed === false) {
    cli.die(
      'could not confirm "' + target + '" is the open conversation — aborting to avoid ' +
        'sending to the wrong chat' +
        (opened.confirmDetail ? ' (' + opened.confirmDetail + ')' : '') +
        '. Retry, or open it first with: signal open ' + JSON.stringify(target),
      { prefix: 'signal' }
    );
  }
  await sleep(400);

  // Focus composer and clear any leftover draft
  const focus = await pwEvalJson(SRC_FOCUS_COMPOSER);
  if (!focus.ok) cli.die('No composer found — is a chat open?', { prefix: 'signal' });
  await pwEvalJson(SRC_CLEAR_COMPOSER);
  await sleep(150);
  await pwEvalJson(SRC_FOCUS_COMPOSER);

  // Insert via browser bridge (playwright-cli subprocess conflicts with the
  // browser CDP connection on the same remote target and hangs).
  const ins = await pwEvalJson(SRC_INSERT_TEXT(text));
  if (!ins.ok) cli.die('Composer insert failed', { prefix: 'signal' });

  const state = await pwEvalJson(SRC_COMPOSER_STATE);
  const typed = cleanText(state && state.content);
  if (!typed) {
    cli.die('Composer did not accept text (CDP type failed). Retry.', { prefix: 'signal' });
  }

  if (draftOnly) {
    const out = {
      ok: true,
      draft: true,
      sent: false,
      to: opened.opened,
      text: typed,
      note: 'Composer filled only. Nothing was sent. Clear manually or send with --yes.',
    };
    if (flags.json) cli.out(out);
    else {
      console.log('DRAFT only (not sent)');
      console.log('To:   ' + (opened.opened && opened.opened.name));
      console.log('Text: ' + typed);
    }
    return;
  }

  // Send = Enter in the composition box (Signal has no separate Send button
  // when the mic/send toggle is voice-mode; Enter is the reliable path).
  await pwEvalJson(SRC_FOCUS_COMPOSER);
  await pwEvalJson(SRC_PRESS_ENTER);

  const after = await pwEvalJson(SRC_COMPOSER_STATE);
  const stillThere = cleanText(after && after.content);
  const sent = !stillThere || stillThere !== typed;

  const result = {
    ok: sent,
    draft: false,
    sent,
    to: opened.opened,
    text: typed,
    composerAfter: stillThere || '',
  };
  if (flags.json) cli.out(result);
  else if (sent) {
    console.log('Sent to ' + (opened.opened && opened.opened.name) + ': ' + typed);
  } else {
    console.error('Send may have failed — composer still holds: ' + stillThere);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── Watch (CLI-bridge poller) ───────────────────────────────────────────────
//
// One crontask licks the shared poller scoop at the smallest interval any watch
// asks for (each watch is then gated to its own --every); that scoop runs
// `signal watch-poll`, which reads the chat LIST once through the reliable
// browser bridge — no leader CDP attach, no chat switching, and it works
// regardless of which conversation is open — fingerprints each watched chat's
// left-pane row, and POSTs that watch's webhook (licking its target scoop)
// only when the row changed.
//
// Why the list row and not the open timeline: Signal renders only the active
// conversation, so reading a specific chat used to require opening it — a
// leader CDP attach that wedged the tray remote's single page-level session,
// or a disruptive view switch. The left pane instead carries every
// conversation's stable id, unread count and last-message preview without
// opening anything, and a chat with new activity surfaces to the top of the
// list. Fingerprint = unread + preview; the preview (message text) stays LOCAL
// in the state file and is never placed in a lick payload.
//
// Cost: one cheap scoop tick per interval (a single `signal chats`); the target
// scoop is licked only on change.

const WATCH_DIR = '/shared/signal-watch';
const WATCH_POLLER_SCOOP = 'signal-watch';
const WATCH_CRON_NAME = 'signal-watch-poll';

function watchStatePath(id) {
  return WATCH_DIR + '/.watch-' + id + '.json';
}

/** Slugify a chat name into a filesystem-safe watch id, made collision-proof
 * by appending a short hash of a stable identity (the conversation id when
 * known, else the full unmodified name). Without this, the lossy slug collides
 * for distinct chats — e.g. every all-non-ASCII name becomes `open-chat`, and
 * names sharing the same normalized first 40 chars map to one id. */
function watchIdFor(chat, stableId) {
  const slug = String(chat || 'open-chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'open-chat';
  const seed = String(stableId || chat || '');
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return slug + '-' + h.toString(36);
}

async function readWatchState(id) {
  try {
    return JSON.parse(await fs.readFile(watchStatePath(id), 'utf8'));
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    return null;
  }
}

async function writeWatchState(id, state) {
  await exec('mkdir -p ' + escapeShellArg(WATCH_DIR));
  await fs.writeFile(watchStatePath(id), JSON.stringify(state, null, 2));
}

async function listWatchStates() {
  const res = await exec('ls ' + escapeShellArg(WATCH_DIR) + '/.watch-*.json 2>/dev/null');
  const files = String(res.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (e) {
      if (e && e.name === 'NodeExitError') throw e;
      // Skip corrupt state rather than failing the whole listing.
    }
  }
  return out;
}

/** Fingerprint a chat's list row. Drift-free (no relative timestamp), and the
 * message-bearing part (preview) stays LOCAL — it is never sent in a lick.
 * Callers must only pass a present row: an absent row means it scrolled out of
 * the virtualized left pane, which is not activity, so cmdWatchPoll() skips it
 * rather than fingerprinting the absence. */
function rowFingerprint(row) {
  const unread = row.unread || 0;
  const preview = cleanText(row.preview || '');
  return unread + '\u00a6' + preview;
}

/** Resolve a stored watch to a live list row: by stable conversation id first,
 * then by exact (Unicode-preserved) name. */
function findWatchRow(chats, state) {
  if (state.convId) {
    const byId = chats.find((c) => c.id && c.id === state.convId);
    if (byId) return byId;
  }
  const want = cleanText(state.chatTitle || state.chat);
  return chats.find((c) => cleanText(c.name) === want) || null;
}

/** Create the shared poll crontask, or reconfigure it so it ticks at the
 * SMALLEST interval any stored watch asks for. A single crontask serves every
 * watch, so a slower task would starve a later `--every=1` watch and a faster
 * one would wake the poller scoop more often than anybody asked; per-watch
 * cadence is then honoured by the due-time gate in cmdWatchPoll(). crontask has
 * no update verb, so a change means delete + create. */
async function ensureWatchCron(everyMinutes) {
  const requested = Math.max(1, Math.min(59, parseInt(everyMinutes, 10) || 2));
  const stored = (await listWatchStates())
    .map((s) => parseInt(s.everyMinutes, 10))
    .filter((n) => n > 0 && n < 60);
  const every = Math.max(1, Math.min(59, Math.min.apply(null, [requested].concat(stored))));
  const list = await exec('crontask list').catch(() => ({ stdout: '' }));
  const line = String(list.stdout || '').split('\n').find((l) => l.indexOf(WATCH_CRON_NAME) !== -1);
  let reconfigured = false;
  if (line) {
    const m = line.match(/\*\/(\d+)\s+\*\s+\*\s+\*\s+\*/);
    const current = m ? parseInt(m[1], 10) : null;
    if (current === every) {
      return { ok: true, existed: true, everyMinutes: current };
    }
    // Wrong cadence for the current set of watches (or an expression we cannot
    // read) — replace it, since crontask cannot edit a task in place.
    const id = line.trim().split(/\s+/)[0];
    if (id) await exec('crontask delete ' + escapeShellArg(id)).catch(() => {});
    reconfigured = true;
  }
  const r = await exec(
    'crontask create --name ' + escapeShellArg(WATCH_CRON_NAME) +
      ' --scoop ' + escapeShellArg(WATCH_POLLER_SCOOP) +
      ' --cron ' + escapeShellArg('*/' + every + ' * * * *')
  );
  return {
    ok: r.exitCode === 0,
    existed: false,
    reconfigured,
    everyMinutes: every,
    out: String(r.stdout || r.stderr || '').trim(),
  };
}

/** After a watch is removed: delete the poll crontask once none remain, else
 * relax it to the slowest cadence the remaining watches still need. */
async function pruneWatchCron() {
  const states = await listWatchStates();
  if (states.length) {
    await ensureWatchCron(
      Math.min.apply(null, states.map((s) => parseInt(s.everyMinutes, 10) || 2))
    );
    return;
  }
  const list = await exec('crontask list').catch(() => ({ stdout: '' }));
  const line = String(list.stdout || '').split('\n').find((l) => l.indexOf(WATCH_CRON_NAME) !== -1);
  if (line) {
    const id = line.trim().split(/\s+/)[0];
    if (id) await exec('crontask delete ' + escapeShellArg(id)).catch(() => {});
  }
}

async function cmdWatch() {
  const chat = positional.join(' ').trim();
  const scoop = flags.scoop;
  const every = Math.max(1, parseInt(flags.every || '2', 10) || 2); // MINUTES
  if (!scoop) {
    cli.die('usage: signal watch <name|id> --scoop=<name> [--every=<minutes>] [--force]', {
      prefix: 'signal',
    });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(scoop))) {
    cli.die('invalid scoop name: ' + scoop, { prefix: 'signal' });
  }
  if (!chat) {
    cli.die('usage: signal watch <name|id> --scoop=<name> [--every=<minutes>]', { prefix: 'signal' });
  }

  // Resolve the chat against the left-pane list — no view switch, no attach.
  const data = await listChats();
  const chats = data.chats || [];
  if (!chats.length) {
    cli.die('no chats visible — is Signal Desktop open on a tray host?', { prefix: 'signal' });
  }
  let row =
    chats.find((c) => c.id === chat || c.serviceId === chat) ||
    chats.find((c) => cleanText(c.name) === cleanText(chat));
  if (!row) {
    const hits = matchChats(chats, chat);
    if (hits.length === 1) row = hits[0];
    else if (hits.length > 1) {
      console.error('Ambiguous match for "' + chat + '":');
      for (const h of hits.slice(0, 8)) console.error('  - ' + h.name);
      process.exit(1);
    }
  }
  if (!row) cli.die('Chat not found in the visible list: ' + chat, { prefix: 'signal' });

  const chatName = row.name || chat;
  const convId = row.id || null;
  const id = watchIdFor(chatName, convId);

  const existing = await readWatchState(id);
  if (existing && !flags.force) {
    console.error('Already watching "' + chatName + '" (scoop: ' + existing.scoop + ').');
    console.error('Use --force to replace, or: signal unwatch ' + id);
    process.exit(1);
  }
  if (existing && existing.webhookId) {
    await exec('webhook delete ' + escapeShellArg(existing.webhookId)).catch(() => {});
  }

  const whResult = await exec('webhook create --scoop ' + escapeShellArg(scoop));
  const idMatch = String(whResult.stdout || '').match(/ID:\s*(\S+)/i);
  const urlMatch = String(whResult.stdout || '').match(/URL:\s*(\S+)/i);
  if (!idMatch || !urlMatch) {
    cli.die(
      'could not create webhook: ' + String(whResult.stderr || whResult.stdout || '').slice(0, 200),
      { prefix: 'signal' }
    );
  }

  const state = {
    watchId: id,
    chat: chatName,
    chatTitle: cleanText(chatName),
    convId: convId,
    scoop: scoop,
    everyMinutes: every,
    webhookId: idMatch[1],
    webhookUrl: urlMatch[1],
    lastFingerprint: rowFingerprint(row), // seed so the current backlog is not reported
    lastPollAt: new Date().toISOString(),
    fires: 0,
    createdAt: new Date().toISOString(),
  };
  await writeWatchState(id, state);
  const cron = await ensureWatchCron(every);

  if (flags.json) return cli.out({ ...state, cron });
  console.log('Watching "' + chatName + '" -> scoop "' + scoop + '"');
  console.log('  Watch ID: ' + id);
  console.log(
    '  Poll:     this watch every ' + every + ' min (shared crontask "' + WATCH_CRON_NAME +
      '" ticks every ' + (cron.everyMinutes || every) + ' min -> scoop "' + WATCH_POLLER_SCOOP + '")'
  );
  console.log('  Webhook:  ' + state.webhookId);
  console.log('  Stop:     signal unwatch ' + id);
  if (!cron.ok) {
    console.error('  NOTE: could not create the poll crontask automatically: ' + (cron.out || ''));
  }
  console.error('  Setup: a scoop named "' + WATCH_POLLER_SCOOP + '" must run `signal watch-poll` on each "' + WATCH_CRON_NAME + '" lick.');
}

// Run one poll pass over every stored watch. Invoked by the poller scoop on
// each cron lick (`signal watch-poll`).
async function cmdWatchPoll() {
  const states = await listWatchStates();
  if (!states.length) {
    if (flags.json) return cli.out({ ok: true, watches: 0, fired: [] });
    console.log('no active watches');
    return;
  }
  const data = await listChats();
  const chats = data.chats || [];
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const fired = [];
  const skipped = [];
  for (const state of states) {
    // Honour this watch's own interval. One shared crontask ticks at the
    // fastest watch's rate, so a slower watch must skip the ticks that are not
    // yet due for it. Small slack so a tick landing a hair early still counts.
    const everyMs = Math.max(1, parseInt(state.everyMinutes, 10) || 2) * 60000;
    const lastMs = Date.parse(state.lastPollAt || '');
    if (Number.isFinite(lastMs) && nowMs - lastMs < everyMs - 15000) {
      skipped.push(state.watchId);
      continue;
    }
    const row = findWatchRow(chats, state);
    state.lastPollAt = now;
    // A row can be absent because the virtualized left pane unmounted it (the
    // user scrolled), not because anything happened. Absence is not activity:
    // leave lastFingerprint untouched so remounting the unchanged row does not
    // read as a change either.
    if (!row) {
      state.lastMissingAt = now;
      await writeWatchState(state.watchId, state);
      continue;
    }
    const fp = rowFingerprint(row);
    // Seed on the first poll so the backlog already on screen is not reported.
    if (state.lastFingerprint == null) {
      state.lastFingerprint = fp;
      await writeWatchState(state.watchId, state);
      continue;
    }
    if (fp === state.lastFingerprint) {
      await writeWatchState(state.watchId, state);
      continue;
    }
    // Change detected. Deliver first; commit lastFingerprint/fires only on a
    // confirmed 2xx so a failed webhook is retried next poll, not swallowed.
    // Use curl via exec — the jsh runtime's fetch() is unreliable for external
    // https here, whereas curl returns deterministically.
    let delivered = false;
    const payload = JSON.stringify({
      source: 'signal-watch',
      watchId: state.watchId,
      chat: state.chat,
      // Stable conversation id, so the woken scoop reads the chat this watch is
      // pinned to even when another conversation shares its display name.
      convId: state.convId || null,
      // Metadata only — message text never leaves Signal.
      unread: row.unread || 0,
      at: now,
      hint: 'New activity in Signal chat "' + state.chat + '". Run: signal read ' +
        JSON.stringify(state.convId || state.chat),
    });
    try {
      const r = await exec(
        'curl -sS -o /dev/null -w ' + escapeShellArg('%{http_code}') +
          ' -X POST -H ' + escapeShellArg('content-type: application/json') +
          ' -d ' + escapeShellArg(payload) +
          ' ' + escapeShellArg(state.webhookUrl)
      );
      const code = parseInt(String(r.stdout || '').trim(), 10);
      delivered = code >= 200 && code < 300;
      if (!delivered) {
        state.lastError = 'webhook HTTP ' + (String(r.stdout || '').trim() || '?') +
          (r.stderr ? ' ' + String(r.stderr).slice(0, 80) : '');
      }
    } catch (e) {
      state.lastError = 'webhook: ' + String((e && e.message) || e).slice(0, 120);
    }
    if (delivered) {
      state.lastFingerprint = fp;
      state.fires = (state.fires || 0) + 1;
      fired.push(state.watchId);
    }
    await writeWatchState(state.watchId, state);
  }
  if (flags.json) return cli.out({ ok: true, watches: states.length, fired, skipped });
  console.log(
    (fired.length ? 'fired: ' + fired.join(', ') : 'no change (' + states.length + ' watch(es))') +
      (skipped.length ? '; not due: ' + skipped.length : '')
  );
}

async function cmdWatches() {
  const states = await listWatchStates();
  if (flags.json) return cli.out(states);
  if (!states.length) {
    console.log('(no active signal watches)');
    return;
  }
  const rows = [
    ['ID', 'CHAT', 'SCOOP', 'EVERY', 'FIRES', 'LAST POLL'],
    ...states.map((s) => [
      s.watchId || '',
      (s.chat || '').slice(0, 24),
      s.scoop || '',
      (s.everyMinutes || '?') + 'm',
      String(s.fires || 0),
      (s.lastPollAt || '').slice(11, 19) || '-',
    ]),
  ];
  console.log(fmt.table(rows, [24, 24, 16, 6, 6, 10]));
}

async function cmdUnwatch() {
  const id = (positional[0] || '').trim();
  if (!id) cli.die('usage: signal unwatch <watch-id|all>', { prefix: 'signal' });
  const targets =
    id === 'all' ? await listWatchStates() : [await readWatchState(id)].filter(Boolean);
  if (!targets.length) {
    console.log('No matching watch (see: signal watches)');
    return;
  }
  for (const state of targets) {
    if (state.webhookId) {
      await exec('webhook delete ' + escapeShellArg(state.webhookId)).catch(() => {});
    }
    await exec('rm -f ' + escapeShellArg(watchStatePath(state.watchId))).catch(() => {});
    console.log('Stopped watching "' + state.chat + '" (' + state.watchId + ')');
  }
  await pruneWatchCron();
}

// With the CLI-bridge poller there is no page state to lose on a leader reload;
// reinject just re-ensures the poll crontask exists for the stored watches.
async function cmdReinject() {
  const states = await listWatchStates();
  if (!states.length) {
    console.log('(no stored watches to reinject)');
    return;
  }
  const every = Math.min.apply(null, states.map((s) => s.everyMinutes || 2));
  const cron = await ensureWatchCron(every);
  console.log(
    (cron.existed
      ? 'poll crontask already active (every ' + cron.everyMinutes + ' min)'
      : cron.ok
        ? (cron.reconfigured ? 'poll crontask reconfigured' : 'poll crontask (re)created') +
          ' to every ' + cron.everyMinutes + ' min'
        : 'FAILED to create poll crontask') +
      ' for ' + states.length + ' watch(es)'
  );
  console.error('Ensure a scoop named "' + WATCH_POLLER_SCOOP + '" runs `signal watch-poll` on each "' + WATCH_CRON_NAME + '" lick.');
}

async function main() {
  switch (subcommand) {
    case 'tabs':
    case 'status':
    case 'tab':
      return cmdTabs();
    case 'chats':
    case 'list':
    case 'ls':
      return cmdChats();
    case 'search':
    case 'find':
      return cmdSearch();
    case 'open':
      return cmdOpen();
    case 'read':
    case 'messages':
    case 'history':
      return cmdRead();
    case 'send':
      return cmdSend();
    case 'watch':
      return cmdWatch();
    case 'watch-poll':
      return cmdWatchPoll();
    case 'watches':
      return cmdWatches();
    case 'unwatch':
      return cmdUnwatch();
    case 'reinject':
      return cmdReinject();
    default:
      console.log(usageText());
      cli.die('unknown subcommand: ' + subcommand, { prefix: 'signal' });
  }
}

main().catch((e) => {
  console.error('signal: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
