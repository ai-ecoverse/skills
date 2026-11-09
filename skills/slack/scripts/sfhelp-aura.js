// sfhelp-aura.js — client for the Salesforce Help portal (help.salesforce.com), where Slack
// support cases live since Slack moved off its own portal (captured live 2026-11-09).
//
// The portal is a Salesforce Experience Cloud (Aura) site with no public REST API for
// customers. Its pages call Apex controller methods through one endpoint:
//   POST /s/sfsites/aura?r=N&aura.ApexAction.execute=1
//   form: message, aura.context, aura.pageURI, aura.token
// Every call runs inside the signed-in tab, so the session cookie and the CSRF token
// (aura.token) never leave the page. This module does no I/O itself: the caller passes
// `evalInPage(source)`, which evaluates an expression in the tab and returns its value.
//
// Note: sliccy:browser 0.1.42 evaluates in a same-origin child frame (Intercom's launcher
// iframe) rather than the top document, so page code goes through `window.top`.

const ORIGIN = 'https://help.salesforce.com';
const TAB_MATCH = /^https:\/\/help\.salesforce\.com\//;
const CASES_URL = `${ORIGIN}/s/cases`;

// Case list filters, from HC_CaseRequestsController.getCasesTableFilters.
const FILTERS = { open: '1', closed: '2' };

// ── page side ────────────────────────────────────────────────────────────────
// Self-contained: serialized with Function#toString and run in the tab.
// Returns {ok:true, value} or {ok:false, code, message}; never throws.
async function pageApexCall(req) {
  const W = window.top;
  const fail = (code, message) => ({ ok: false, code, message: String(message || code).slice(0, 500) });
  try {
    if (!/^https:\/\/help\.salesforce\.com\/s(\/|$)/.test(W.location.href)) return fail('wrong-page', W.location.href.split('?')[0]);
    const A = W.$A;
    if (!A || !A.clientService || !A.getContext) return fail('not-ready', 'Aura is not loaded in this tab');
    const cs = A.clientService;
    // getToken() returns the token only behind an internal flag; the minified field it
    // reads is named in its own source ("function(){if(this.os)return this.Ec}").
    let token = cs.getToken();
    if (!token) {
      const m = /return this\.([\w$]+)/.exec(String(cs.getToken));
      token = m ? cs[m[1]] : '';
    }
    if (!token) return fail('no-token', 'no Aura token in this tab');
    const fwScript = [...W.document.scripts].map((s) => s.src).find((s) => s.includes('/auraFW/javascript/'));
    if (!fwScript) return fail('not-ready', 'no Aura framework script in this tab');
    const ctx = A.getContext();
    const context = {
      mode: ctx.mode,
      fwuid: fwScript.split('/auraFW/javascript/')[1].split('/')[0],
      app: 'siteforce:communityApp',
      loaded: ctx.loaded,
      dn: [],
      globals: {},
      uad: false,
    };
    const action = {
      id: '1;a',
      descriptor: 'aura://ApexActionController/ACTION$execute',
      callingDescriptor: 'UNKNOWN',
      params: { namespace: '', classname: req.classname, method: req.method, cacheable: false, isContinuation: false },
    };
    if (req.params) action.params.params = req.params;
    const body = new W.URLSearchParams({
      message: JSON.stringify({ actions: [action] }),
      'aura.context': JSON.stringify(context),
      'aura.pageURI': W.location.pathname + W.location.search,
      'aura.token': token,
    });
    const res = await W.fetch('/s/sfsites/aura?r=1&aura.ApexAction.execute=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      credentials: 'include',
    });
    const text = await res.text();
    if (!res.ok) return fail('http', `HTTP ${res.status}`);
    // Framework errors come back as */{...}/*ERROR*/ with status 200.
    if (text.startsWith('*/')) {
      if (text.includes('clientOutOfSync')) return fail('out-of-sync', 'the portal was updated');
      if (text.includes('invalidSession')) return fail('invalid-session', 'session or token rejected');
      return fail('aura', text.replace(/^\*\/|\/\*ERROR\*\/$/g, '').slice(0, 300));
    }
    let json;
    try { json = JSON.parse(text); } catch { return fail('parse', /<html|<!DOCTYPE/i.test(text) ? 'got an HTML page' : 'response is not JSON'); }
    const a = json.actions && json.actions[0];
    if (!a) return fail('aura', 'no action in response');
    if (a.state !== 'SUCCESS') {
      const err = (a.error || []).map((e) => e.message || (e.pageErrors && e.pageErrors[0] && e.pageErrors[0].message) || JSON.stringify(e)).join('; ');
      return fail('apex', err || a.state);
    }
    let v = a.returnValue && typeof a.returnValue === 'object' && 'returnValue' in a.returnValue ? a.returnValue.returnValue : a.returnValue;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* plain string */ } }
    return { ok: true, value: v };
  } catch (e) {
    return fail('page', e && e.message);
  }
}

function apexSource(classname, method, params) {
  return `(${pageApexCall.toString()})(${JSON.stringify({ classname, method, params: params ?? null })})`;
}

// ── host side ────────────────────────────────────────────────────────────────

class AuraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuraError';
    this.code = code;
  }
}

const HINTS = {
  'wrong-page': `open ${CASES_URL} in the tab (it is on another page)`,
  'not-ready': `open ${CASES_URL} and wait for it to load`,
  'no-token': `reload ${CASES_URL} and sign in`,
  'out-of-sync': 'the portal was updated since the tab loaded; reload the tab and retry',
  'invalid-session': `your Salesforce Help session expired; reload ${CASES_URL}, sign in, and retry`,
};

function hintFor(err) {
  return HINTS[err && err.code] || '';
}

/** Salesforce record ids: 15 or 18 base-62 characters; cases start with 500. */
function isCaseId(s) {
  return typeof s === 'string' && /^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(s);
}

/** Case numbers are the digits shown in the portal, e.g. 400000002. */
function isCaseNumber(s) {
  return typeof s === 'string' && /^\d{5,12}$/.test(s);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML (comment bodies) → plain text. Decodes entities in one pass, so "&amp;amp;" → "&amp;". */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|li)>\s*/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Plain text → the HTML the comment editor sends (it posts "<p>…</p>").
 * Blank lines separate paragraphs; single newlines become <br>.
 */
function textToCommentHtml(text) {
  const paras = String(text).replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** The case-view template → one flat, documented shape. */
function normalizeCase(tpl, caseId) {
  const t = tpl || {};
  const s = t.sections || {};
  const d = s.details || {};
  const bar = (s.statusBar && s.statusBar.buttons && s.statusBar.buttons.data) || {};
  return {
    caseId: caseId || null,
    caseNumber: t.caseNumber ?? null,
    subject: t.subject ?? null,
    status: t.status ?? null,
    product: d.product ?? null,
    topic: d.topic ?? null,
    severity: d.severityLevel ?? null,
    createdBy: d.createdByName ?? null,
    description: d.description ?? t.description ?? null,
    isClosed: !!bar.isClosed,
    canClose: bar.isCloseDisabled === false,
    canReopen: bar.isReopenDisabled === false,
    canEscalate: !!bar.isEscalateAvailable && !bar.isEscalateDisabled,
    comments: ((s.comments && s.comments.comments) || []).map((c) => ({
      id: c.id,
      author: c.userName,
      fromSupport: !!c.isAgentComment,
      createdAt: c.compareCreatedDate || null,
      created: c.createdDate || null,
      text: htmlToText(c.commentText),
      attachments: (c.attachments || []).map((a) => ({ name: a.fileName, documentId: a.contentDocumentId, versionId: a.contentVersionId })),
    })),
    files: ((s.attachments && s.attachments.files) || []).map((f) => ({ name: f.fileName || f.title, documentId: f.contentDocumentId, versionId: f.contentVersionId })),
  };
}

function listParams({ filter = 'open', search = '', limit = 20, offset = 0 } = {}) {
  return {
    params: JSON.stringify({
      filterName: '',
      searchValue: search,
      filterValue: FILTERS[filter] || FILTERS.open,
      sortValue: 'priorityStatus',
      sortDirection: 'desc',
      loadLimit: limit,
      offset,
    }),
  };
}

/**
 * makeClient(evalInPage) → the portal's Apex methods.
 * evalInPage(source) must evaluate `source` in the help.salesforce.com tab and return its value.
 */
function makeClient(evalInPage) {
  async function apex(classname, method, params) {
    let r = await evalInPage(apexSource(classname, method, params));
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* leave as is */ } }
    if (!r || typeof r !== 'object') throw new AuraError('bridge', 'no result from the tab');
    if (!r.ok) throw new AuraError(r.code, r.message);
    return r.value;
  }

  return {
    apex,
    /** {orgId, orgName, username, cloud, …} for the signed-in user and selected org. */
    async context() {
      return apex('HC_RequestsController', 'getActiveContext');
    },
    /** [{value,label}]: 1 My Open Cases, 2 My Closed Cases, … */
    async filters() {
      return apex('HC_CaseRequestsController', 'getCasesTableFilters');
    },
    /** {cases:[{caseId,caseNumber,subject,status,openDate,contactName}], total} */
    async listCases(opts = {}) {
      const p = listParams(opts);
      const [cases, total] = await Promise.all([
        apex('HC_CaseRequestsController', 'getCasesTableRecords', p),
        apex('HC_CaseRequestsController', 'getCasesTableTotalCount', p),
      ]);
      return { cases: Array.isArray(cases) ? cases : [], total: typeof total === 'number' ? total : null };
    },
    /** The raw case-view template. */
    async caseTemplate(caseId) {
      return apex('HC_CaseRequestsController', 'getCaseViewTemplate', { caseId, caseRecord: null });
    },
    async getCase(caseId) {
      return normalizeCase(await this.caseTemplate(caseId), caseId);
    },
    /** Case number or record id → record id. Searches open, then closed cases. */
    async resolveCaseId(ref) {
      const s = String(ref || '').trim().replace(/^#/, '');
      if (isCaseId(s)) return s;
      if (!isCaseNumber(s)) throw new AuraError('usage', `not a case number or id: ${ref}`);
      for (const filter of ['open', 'closed']) {
        for (let offset = 0; offset < 1000; offset += 50) {
          const { cases } = await this.listCases({ filter, limit: 50, offset });
          const hit = cases.find((c) => String(c.caseNumber) === s);
          if (hit) return hit.caseId;
          if (cases.length < 50) break;
        }
      }
      throw new AuraError('not-found', `no case #${s} among your open or closed cases`);
    },
    /**
     * Add a comment. `html` is the editor's HTML; use textToCommentHtml for plain text.
     * Files already uploaded to the case can be linked with contentDocumentIds/versionIds.
     * → {isSuccess, message, caseComment}
     */
    async addComment(caseId, html, { contentDocumentIds = [], versionIds = [] } = {}) {
      const inputData = JSON.stringify({ caseId, commentBody: html, contentDocumentIds, versionIds });
      const r = await apex('HC_CaseRequestsController', 'submitCaseComment', { inputData });
      if (!r || r.isSuccess !== true) throw new AuraError('apex', (r && r.message) || 'the portal did not accept the comment');
      return r;
    },
  };
}

module.exports = {
  ORIGIN,
  TAB_MATCH,
  CASES_URL,
  FILTERS,
  AuraError,
  pageApexCall,
  apexSource,
  makeClient,
  hintFor,
  isCaseId,
  isCaseNumber,
  escapeHtml,
  htmlToText,
  textToCommentHtml,
  normalizeCase,
  listParams,
};
