// intercom-messenger.js — client for an Intercom Messenger embedded in a signed-in page,
// talking to Intercom's web messenger API as that page's end user (captured live on
// help.salesforce.com, 2026-11-09).
//
// The messenger's requests are form posts to https://api-iam.intercom.io/messenger/web/<path>
// that carry the widget's session in the body (app_id, s, user_data with the identity JWT,
// anonymous_session, device_identifier, …). There is no API key for an end user, and the
// official npm clients don't fit: intercom-client is the workspace admin API, and
// @intercom/messenger-js-sdk only wraps window.Intercom(), which can't read conversations.
//
// So this module borrows the widget's own request body inside the page: it calls the
// documented `Intercom('update')`, which makes the widget send a /messenger/web/ping, keeps
// that body in page memory, and reuses it with a fresh Idempotency-Key. The session fields
// never leave the page; only API responses do. Like sfhelp-aura.js it does no I/O itself.

const API_BASE = 'https://api-iam.intercom.io';

// Paths the page helper will call. Anything else is refused in the page.
const ALLOWED = [
  /^\/messenger\/web\/conversations$/,
  /^\/messenger\/web\/conversations\/\d+$/,
  /^\/messenger\/web\/conversations\/\d+\/reply$/,
  /^\/messenger\/web\/messages$/,
];

// ── page side ────────────────────────────────────────────────────────────────
async function pageMessengerCall(req) {
  const W = window.top;
  const fail = (code, message) => ({ ok: false, code, message: String(message || code).slice(0, 500) });
  try {
    if (typeof W.Intercom !== 'function') return fail('no-messenger', 'no Intercom Messenger on this page');
    if (!req.allowed.some((src) => new RegExp(src).test(req.path))) return fail('refused', `path not allowed: ${req.path}`);
    const fresh = W.__sliccIcTpl && Date.now() - W.__sliccIcTpl.at < 10 * 60 * 1000;
    if (!fresh || req.refresh) {
      W.__sliccIcTpl = null;
      const wins = [W];
      for (const f of W.document.querySelectorAll('iframe')) {
        try { if (f.contentWindow && f.contentWindow.XMLHttpRequest) wins.push(f.contentWindow); } catch { /* cross-origin */ }
      }
      const restore = [];
      for (const w of wins) {
        const X = w.XMLHttpRequest.prototype, open = X.open, send = X.send, fetch = w.fetch;
        X.open = function (m, u) { this.__sliccIcUrl = String(u); return open.apply(this, arguments); };
        X.send = function (b) {
          if (/\/messenger\/web\//.test(this.__sliccIcUrl || '') && typeof b === 'string' && b.includes('user_data=')) W.__sliccIcTpl = { body: b, at: Date.now() };
          return send.apply(this, arguments);
        };
        w.fetch = function (u, o) {
          if (/\/messenger\/web\//.test(String((u && u.url) || u)) && o && typeof o.body === 'string' && o.body.includes('user_data=')) W.__sliccIcTpl = { body: o.body, at: Date.now() };
          return fetch.apply(this, arguments);
        };
        restore.push(() => { X.open = open; X.send = send; w.fetch = fetch; });
      }
      try {
        W.Intercom('update', { last_request_at: Math.floor(Date.now() / 1000) });
        for (let i = 0; i < 60 && !W.__sliccIcTpl; i++) await new Promise((r) => setTimeout(r, 250));
      } finally {
        for (const f of restore) f();
      }
      if (!W.__sliccIcTpl) return fail('no-session', 'the messenger sent no request to borrow; it may not be booted for a signed-in user');
    }
    const body = new W.URLSearchParams(W.__sliccIcTpl.body);
    for (const k of ['source', 'sampling', 'initial_view', 'request_origin', 'metrics', 'logs', 'op_metrics']) body.delete(k);
    const key = new Uint8Array(8);
    W.crypto.getRandomValues(key);
    body.set('Idempotency-Key', [...key].map((b) => b.toString(16).padStart(2, '0')).join(''));
    for (const [k, v] of Object.entries(req.params || {})) body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const res = await W.fetch(req.base + req.path, { method: 'POST', body, credentials: 'include' });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) return fail('auth', `HTTP ${res.status}`);
    if (!res.ok) return fail('http', `HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { return { ok: true, value: JSON.parse(text) }; } catch { return fail('parse', 'response is not JSON'); }
  } catch (e) {
    return fail('page', e && e.message);
  }
}

function callSource(path, params, { refresh = false } = {}) {
  const req = { base: API_BASE, path, params: params || {}, refresh, allowed: ALLOWED.map((r) => r.source) };
  return `(${pageMessengerCall.toString()})(${JSON.stringify(req)})`;
}

// ── host side ────────────────────────────────────────────────────────────────

class MessengerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessengerError';
    this.code = code;
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A conversation part's text, from its blocks (paragraph text is HTML) or body. */
function partText(part) {
  const blocks = Array.isArray(part && part.blocks) ? part.blocks : [];
  if (blocks.length) {
    return blocks
      .map((b) => {
        if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'subheading' || b.type === 'code') return stripTags(b.text);
        if (b.type === 'orderedList' || b.type === 'unorderedList') return (b.items || []).map((i) => `- ${stripTags(i)}`).join('\n');
        if (b.type === 'image') return `[image ${b.url || ''}]`.trim();
        if (b.type === 'attachmentList') return (b.attachments || []).map((a) => `[file ${a.name || a.url || ''}]`).join('\n');
        if (b.text) return stripTags(b.text);
        return `[${b.type}]`;
      })
      .join('\n\n');
  }
  return stripTags((part && part.body) || '');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text → messenger blocks: one paragraph per blank-line-separated chunk. */
function textToBlocks(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((p) => ({ type: 'paragraph', text: escapeHtml(p).replace(/\n/g, '<br>') }));
}

function authorOf(part) {
  const a = (part && part.author) || {};
  const name = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || null;
  return { type: a.type || null, name, isUser: a.type === 'widget_user' || a.type === 'user' || a.type === 'lead' };
}

/** A conversation → {id, title, state, open, caseRef, messages:[{id, from, isUser, at, text}]}. */
function normalizeConversation(c) {
  const parts = Array.isArray(c && c.conversation_parts) ? c.conversation_parts : [];
  return {
    id: c && c.id != null ? String(c.id) : null,
    title: (c && c.title) || null,
    state: (c && c.state) || null,
    open: !!c && c.state !== 'state_closed',
    canReply: !!c && !c.prevent_end_user_replies && c.state !== 'state_closed',
    updatedAt: c && c.updated_at ? new Date(c.updated_at * 1000).toISOString() : null,
    salesforceReference: (c && c.salesforce_external_reference) || null,
    messages: parts.map((p) => {
      const who = authorOf(p);
      return { id: p.id != null ? String(p.id) : null, type: p.part_type || null, from: who.name, authorType: who.type, isUser: who.isUser, at: p.created_at ? new Date(p.created_at * 1000).toISOString() : null, text: partText(p) };
    }),
  };
}

/** Find a case number in a support reply, e.g. "Case #400000002 has been opened". */
function findCaseNumber(text) {
  const m = /\bcase\s*(?:#|number|no\.?)?\s*:?\s*(\d{6,12})\b/i.exec(String(text || ''));
  return m ? m[1] : null;
}

function makeClient(evalInPage) {
  async function call(path, params, opts) {
    let r = await evalInPage(callSource(path, params, opts));
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* leave */ } }
    if (!r || typeof r !== 'object') throw new MessengerError('bridge', 'no result from the tab');
    // A stale borrowed session: borrow a new one once.
    if (!r.ok && r.code === 'auth' && !(opts && opts.refresh)) return call(path, params, { ...(opts || {}), refresh: true });
    if (!r.ok) throw new MessengerError(r.code, r.message);
    return r.value;
  }

  const client = {
    call,
    /** [{id, title, state, updatedAt, …}] newest first, as the messenger lists them. */
    async conversations() {
      const r = await call('/messenger/web/conversations');
      const list = Array.isArray(r) ? r : (r && r.conversations) || [];
      return list.map((c) => {
        const n = normalizeConversation(c);
        delete n.messages;
        return n;
      });
    },
    async conversationRaw(id) {
      if (!/^\d+$/.test(String(id))) throw new MessengerError('usage', `not a conversation id: ${id}`);
      return call(`/messenger/web/conversations/${id}`);
    },
    async conversation(id) {
      return normalizeConversation(await client.conversationRaw(id));
    },
    // Sending: endpoints and fields from the messenger's own code (frame-modern bundle,
    // 2026-11-09): blocks, created_at, client_assigned_uuid. Not yet exercised live.
    async reply(id, text) {
      if (!/^\d+$/.test(String(id))) throw new MessengerError('usage', `not a conversation id: ${id}`);
      return call(`/messenger/web/conversations/${id}/reply`, {
        blocks: JSON.stringify(textToBlocks(text)),
        created_at: new Date().toString(),
        client_assigned_uuid: crypto.randomUUID(),
      });
    },
    /** Start a new conversation. → the created conversation (shape as the reply endpoint returns). */
    async start(text) {
      return call('/messenger/web/messages', {
        blocks: JSON.stringify(textToBlocks(text)),
        created_at: new Date().toString(),
        client_assigned_uuid: crypto.randomUUID(),
        self_serve_suggestions_match: 'false',
      });
    },
    /**
     * Poll until a message not from the user arrives after `afterCount` messages, or the
     * conversation closes. → the normalized conversation. `sleep` is injectable for tests.
     */
    async waitForReply(id, { afterCount = 0, timeoutMs = 120000, intervalMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), quietMs = 6000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let seenAt = 0;
      let seenCount = 0;
      let last = null;
      for (;;) {
        last = await client.conversation(id);
        const fresh = last.messages.slice(afterCount).filter((m) => !m.isUser && m.text);
        if (fresh.length) {
          // Fin often answers in several parts; wait until it has been quiet a moment.
          if (fresh.length !== seenCount) { seenCount = fresh.length; seenAt = Date.now(); }
          if (Date.now() - seenAt >= quietMs || !last.open) return last;
        } else if (!last.open) {
          return last;
        }
        if (Date.now() >= deadline) return last;
        await sleep(intervalMs);
      }
    },
  };
  return client;
}

module.exports = {
  API_BASE,
  ALLOWED,
  MessengerError,
  pageMessengerCall,
  callSource,
  makeClient,
  partText,
  stripTags,
  textToBlocks,
  normalizeConversation,
  findCaseNumber,
};
