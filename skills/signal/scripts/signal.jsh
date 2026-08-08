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
//   signal help
//
// Register once per session:
//   touch /usr/bin/signal; hash -r
//
// Safety: send requires --yes. Never auto-send. Do not dump full histories into
// scoop notifications — summarize.

const { exec } = require('sliccy:exec');
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
  return new Promise((r) => setTimeout(r, ms));
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
  if (_tabId) {
    const raw = await tabListRaw();
    if (raw.includes(_tabId)) return _tabId;
    _tabId = null;
  }
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
  // Exact name (case-insensitive)
  if (!btn) {
    btn = buttons.find((b) => meta(b).name.toLowerCase() === qLower);
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
  // Wait for ConversationView to mount
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    const state = await pwEvalJson(`
      (() => JSON.stringify({
        hasView: !!document.querySelector('.ConversationView, .module-timeline'),
        title: (document.querySelector('.module-ConversationHeader__header__info__title') || {}).textContent || null
      }))()
    `);
    if (state.hasView) break;
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

Setup (once per session):
  touch /usr/bin/signal; hash -r

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
  signal help                       This help

Safety:
  - Default is read-only.
  - \`send\` requires --yes. Prefer --draft to validate composer fill.
  - Do not exfiltrate full message history into notifications; summarize.
  - Do not change Signal account settings.

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
        console.error('Ambiguous match:');
        for (const m of res.matches || []) console.error('  - ' + m.name);
        process.exit(1);
      }
      cli.die(res.error === 'not_found' ? 'Chat not found: ' + q : res.error || 'open failed', {
        prefix: 'signal',
      });
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
          ? 'Ambiguous chat name; be more specific'
          : opened.error || 'open failed',
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

  // Type via CDP Input (Quill/React picks this up; DOM execCommand alone does not)
  await pwType(text);
  await sleep(300);

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
  await pwPress('Enter');
  await sleep(600);

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
    default:
      console.log(usageText());
      cli.die('unknown subcommand: ' + subcommand, { prefix: 'signal' });
  }
}

main().catch((e) => {
  console.error('signal: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
