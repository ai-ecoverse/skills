// slack-support.test.js — tst suite for the Salesforce Help (Aura) and Intercom clients
// behind slack-support and intercom, and their argv parser.
//
// Run from skills/slack/:  tst tests/slack-support.test.js
//
// Offline: the page-side functions are run here, in this realm, against a fake
// `window.top` with recorded responses (captured live 2026-11-09). Each test evaluates the
// exact source string the clients send to the tab, so the serialized code is what's tested.

import test, { is, ok } from 'tst';
import * as auraMod from '../scripts/sfhelp-aura.js';
import * as icMod from '../scripts/intercom-messenger.js';
import * as argsMod from '../scripts/support-args.js';

const aura = auraMod.default || auraMod;
const ic = icMod.default || icMod;
const { parseArgs, boolFlag } = argsMod.default || argsMod;

// ── a fake help.salesforce.com page ──────────────────────────────────────────

const FWUID = 'NjZ1S2dpaDFCTURrSEliQmh0ZXRhZ2tVMjdnTGFERUU2S3FfSVdrcU92bkExNS4zLjE2MDEw';

function fakeAuraPage(respond, { token = 'tok-123', getTokenReturns = undefined, href = 'https://help.salesforce.com/s/cases' } = {}) {
  const calls = [];
  const clientService = { Ec: token, os: false };
  // Mirrors the minified original: function(){if(this.os)return this.Ec}
  clientService.getToken = function () { if (this.os) return this.Ec; return getTokenReturns; };
  const top = {
    location: { href, pathname: new URL(href).pathname, search: '' },
    document: { scripts: [{ src: `https://help.salesforce.com/s/sfsites/auraFW/javascript/${FWUID}/aura_prod.js` }] },
    URLSearchParams,
    $A: { clientService, getContext: () => ({ mode: 'PROD', loaded: { 'APPLICATION@markup://siteforce:communityApp': 'x' } }) },
    fetch: async (url, init) => {
      const form = new URLSearchParams(init.body);
      const call = { url, form, message: JSON.parse(form.get('message')), context: JSON.parse(form.get('aura.context')) };
      calls.push(call);
      const { status = 200, text } = respond(call);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    },
  };
  return { top, calls };
}

// Evaluate a page-source string with `window` bound to a fake.
async function runInFakePage(source, fakeTop) {
  const fn = new Function('window', `return ${source};`);
  return fn({ top: fakeTop });
}

function auraOk(returnValue) {
  return { text: JSON.stringify({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue, cacheable: false }, error: [] }] }) };
}

// Recorded 2026-11-09 (ids replaced, user details trimmed).
const LIST = JSON.stringify([
  { subject: 'Slack mobile Link Preview Bug: Slack', status: 'New', openDate: '9 Nov, 2026 1:40 AM', caseNumber: '400000002', caseId: '500000000000002AAA', contactName: 'A User' },
  { subject: 'Slack Login Issue: Slack', status: 'Working', openDate: '6 Nov, 2026 1:56 AM', caseNumber: '400000001', caseId: '500000000000001AAA', contactName: 'A User' },
]);
const TEMPLATE = JSON.stringify({
  subject: 'Slack mobile Link Preview Bug: Slack',
  status: 'New',
  caseNumber: '400000002',
  sections: {
    details: { product: 'Slack', topic: 'Using Slack', severityLevel: 'Severity 3 - Minor functionality impacted and time-sensitive', createdByName: 'A User', description: 'Question …' },
    comments: { comments: [{ id: '00a000000000001AAA', userName: 'A User', isAgentComment: false, createdDate: 'November 9, 2026 at 1:46 AM', compareCreatedDate: '2026-11-09T09:46:00.000Z', commentText: ' R&amp;#x26;B shows &quot;R&amp;amp;B&quot;', attachments: [{ fileName: 'shot.png', contentDocumentId: '069000000000001AAA', contentVersionId: '068000000000001AAA' }] }] },
    attachments: { files: [{ fileName: 'shot.png', contentDocumentId: '069000000000001AAA', contentVersionId: '068000000000001AAA' }] },
    statusBar: { buttons: { data: { isClosed: false, isCloseDisabled: false, isReopenDisabled: true, isEscalateAvailable: true, isEscalateDisabled: false } } },
  },
});

// ── sfhelp-aura: page side ───────────────────────────────────────────────────

test('aura: builds the Apex action, framework id and token the portal expects', async () => {
  const { top, calls } = fakeAuraPage(() => auraOk(LIST));
  const r = await runInFakePage(aura.apexSource('HC_CaseRequestsController', 'getCasesTableRecords', { params: '{}' }), top);
  is(r.ok, true);
  is(r.value.length, 2);
  const c = calls[0];
  is(c.url, '/s/sfsites/aura?r=1&aura.ApexAction.execute=1');
  is(c.form.get('aura.token'), 'tok-123', 'token read from the field getToken names');
  is(c.context.fwuid, FWUID);
  is(c.context.app, 'siteforce:communityApp');
  const a = c.message.actions[0];
  is(a.descriptor, 'aura://ApexActionController/ACTION$execute');
  is(a.params.classname, 'HC_CaseRequestsController');
  is(a.params.method, 'getCasesTableRecords');
  is(a.params.params, { params: '{}' });
});

test('aura: a method without params sends no params key', async () => {
  const { top, calls } = fakeAuraPage(() => auraOk('{"orgId":"E1"}'));
  const r = await runInFakePage(aura.apexSource('HC_RequestsController', 'getActiveContext'), top);
  is(r.value, { orgId: 'E1' }, 'double-encoded returnValue is parsed');
  is('params' in calls[0].message.actions[0].params, false);
});

test('aura: getToken() is used when it returns a value', async () => {
  const { top, calls } = fakeAuraPage(() => auraOk('1'), { getTokenReturns: 'direct' });
  await runInFakePage(aura.apexSource('C', 'm'), top);
  is(calls[0].form.get('aura.token'), 'direct');
});

test('aura: framework errors map to codes the CLI can explain', async () => {
  const cases = [
    ['*/{"event":{"descriptor":"markup://aura:clientOutOfSync"},"exceptionEvent":true}/*ERROR*/', 'out-of-sync'],
    ['*/{"event":{"descriptor":"markup://aura:invalidSession","attributes":{"values":{"newToken":"invalid_csrf"}}}}/*ERROR*/', 'invalid-session'],
    ['<!DOCTYPE html><html>login</html>', 'parse'],
  ];
  for (const [text, code] of cases) {
    const { top } = fakeAuraPage(() => ({ text }));
    const r = await runInFakePage(aura.apexSource('C', 'm'), top);
    is(r.ok, false);
    is(r.code, code, code);
  }
});

test('aura: an Apex ERROR state reports its message', async () => {
  const { top } = fakeAuraPage(() => ({ text: JSON.stringify({ actions: [{ state: 'ERROR', error: [{ message: 'Insufficient access' }] }] }) }));
  const r = await runInFakePage(aura.apexSource('C', 'm'), top);
  is(r.code, 'apex');
  is(r.message, 'Insufficient access');
});

test('aura: refuses to call from another page', async () => {
  const { top, calls } = fakeAuraPage(() => auraOk('1'), { href: 'https://help.salesforce.com/apex/other' });
  const r = await runInFakePage(aura.apexSource('C', 'm'), top);
  is(r.code, 'wrong-page');
  is(calls.length, 0);
});

test('aura: arguments are embedded as JSON, not spliced into code', async () => {
  const evil = "x'); window.pwned = 1; ('";
  const { top, calls } = fakeAuraPage(() => auraOk('1'));
  await runInFakePage(aura.apexSource('C', 'm', { caseId: evil }), top);
  is(calls[0].message.actions[0].params.params.caseId, evil);
  is(top.pwned, undefined);
});

// ── sfhelp-aura: host side ───────────────────────────────────────────────────

function routedClient(routes) {
  const seen = [];
  const { top } = fakeAuraPage((call) => {
    const p = call.message.actions[0].params;
    seen.push({ method: p.method, params: p.params });
    const r = routes[p.method];
    if (r === undefined) throw new Error(`unexpected ${p.method}`);
    return auraOk(typeof r === 'function' ? r(p.params) : r);
  });
  return { client: aura.makeClient((src) => runInFakePage(src, top)), seen };
}

test('aura client: listCases returns cases and total; filter maps to the portal value', async () => {
  const { client, seen } = routedClient({ getCasesTableRecords: LIST, getCasesTableTotalCount: 2 });
  const r = await client.listCases({ filter: 'closed', limit: 5 });
  is(r.total, 2);
  is(r.cases[0].caseNumber, '400000002');
  const p = JSON.parse(seen[0].params.params);
  is(p.filterValue, '2');
  is(p.loadLimit, 5);
});

test('aura client: resolveCaseId accepts an id as is and looks up a number', async () => {
  const { client, seen } = routedClient({ getCasesTableRecords: LIST, getCasesTableTotalCount: 2 });
  is(await client.resolveCaseId('500000000000002AAA'), '500000000000002AAA');
  is(seen.length, 0, 'no lookup for an id');
  is(await client.resolveCaseId('#400000001'), '500000000000001AAA');
});

test('aura client: resolveCaseId rejects junk and reports a missing number', async () => {
  const { client } = routedClient({ getCasesTableRecords: '[]', getCasesTableTotalCount: 0 });
  let e = null;
  try { await client.resolveCaseId('123'); } catch (err) { e = err; }
  is(e && e.code, 'usage');
  e = null;
  try { await client.resolveCaseId('999999999'); } catch (err) { e = err; }
  is(e && e.code, 'not-found');
});

test('aura client: getCase normalizes the template and decodes comment HTML once', async () => {
  const { client } = routedClient({ getCaseViewTemplate: TEMPLATE });
  const c = await client.getCase('500000000000002AAA');
  is(c.caseNumber, '400000002');
  is(c.severity, 'Severity 3 - Minor functionality impacted and time-sensitive');
  is(c.canClose, true);
  is(c.canReopen, false);
  is(c.canEscalate, true);
  is(c.comments.length, 1);
  is(c.comments[0].text, 'R&#x26;B shows "R&amp;B"', 'entities decoded exactly one level');
  is(c.comments[0].attachments[0].documentId, '069000000000001AAA');
  is(c.files.length, 1);
});

test('aura client: addComment sends inputData as a JSON string and checks isSuccess', async () => {
  const { client, seen } = routedClient({ submitCaseComment: '{"isSuccess":true,"message":null,"caseComment":{"id":"00a1"}}' });
  const r = await client.addComment('500000000000002AAA', '<p>hi</p>', { contentDocumentIds: ['069x'] });
  is(r.caseComment.id, '00a1');
  const input = JSON.parse(seen[0].params.inputData);
  is(input, { caseId: '500000000000002AAA', commentBody: '<p>hi</p>', contentDocumentIds: ['069x'], versionIds: [] });
});

test('aura client: addComment fails when the portal says isSuccess false', async () => {
  const { client } = routedClient({ submitCaseComment: '{"isSuccess":false,"message":"Comment too long"}' });
  let e = null;
  try { await client.addComment('500000000000002AAA', '<p>x</p>'); } catch (err) { e = err; }
  is(e && e.message, 'Comment too long');
});

test('aura: textToCommentHtml escapes markup and keeps paragraphs', () => {
  is(aura.textToCommentHtml('R&B <meta "x">\nline2\n\npara2'), '<p>R&amp;B &lt;meta &quot;x&quot;&gt;<br>line2</p><p>para2</p>');
});

test('aura: htmlToText round-trips textToCommentHtml', () => {
  const t = 'Shows "&amp;" for &#x26; in <meta>\nnext\n\nlast';
  is(aura.htmlToText(aura.textToCommentHtml(t)), t);
});

test('aura: case id and number validators', () => {
  ok(aura.isCaseId('500000000000002AAA'));
  ok(aura.isCaseId('500000000000002'));
  ok(!aura.isCaseId('001000000000002AAA'), 'an account id is not a case id');
  ok(aura.isCaseNumber('400000002'));
  ok(!aura.isCaseNumber('48235575a'));
});

// ── intercom-messenger ───────────────────────────────────────────────────────

const TPL_BODY = 'app_id=udbi4dh7&v=3&g=abc&s=sess-uuid&user_data=JWTBUNDLE&anonymous_session=anon&device_identifier=dev&Idempotency-Key=old&source=ping&sampling=1';

function fakeIntercomPage(respond, { hasMessenger = true } = {}) {
  const calls = [];
  class XHR {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const top = {
    URLSearchParams,
    crypto: globalThis.crypto,
    document: { querySelectorAll: () => [] },
    XMLHttpRequest: XHR,
    fetch: async (url, init) => {
      calls.push({ url, form: new URLSearchParams(init.body) });
      const { status = 200, body } = respond(url, calls.length);
      return { ok: status < 300, status, text: async () => JSON.stringify(body) };
    },
  };
  if (hasMessenger) {
    top.Intercom = () => {
      // The widget answers Intercom('update') with a ping carrying its session.
      const x = new top.XMLHttpRequest();
      x.open('POST', 'https://api-iam.intercom.io/messenger/web/ping');
      x.send(TPL_BODY);
    };
  }
  return { top, calls };
}

test('intercom: borrows the widget body, drops ping-only fields, sets a new idempotency key', async () => {
  const { top, calls } = fakeIntercomPage(() => ({ body: { conversations: [] } }));
  const r = await runInFakePage(ic.callSource('/messenger/web/conversations'), top);
  is(r.ok, true);
  is(calls[0].url, 'https://api-iam.intercom.io/messenger/web/conversations');
  const f = calls[0].form;
  is(f.get('s'), 'sess-uuid');
  is(f.get('user_data'), 'JWTBUNDLE');
  is(f.get('source'), null);
  is(f.get('sampling'), null);
  ok(f.get('Idempotency-Key') !== 'old' && /^[0-9a-f]{16}$/.test(f.get('Idempotency-Key')));
});

test('intercom: the page hooks are removed after borrowing', async () => {
  const { top } = fakeIntercomPage(() => ({ body: {} }));
  const open = top.XMLHttpRequest.prototype.open;
  const fetch = top.fetch;
  await runInFakePage(ic.callSource('/messenger/web/conversations'), top);
  is(top.XMLHttpRequest.prototype.open, open);
  is(top.fetch, fetch);
});

test('intercom: the result carries no session fields back to the host', async () => {
  const { top } = fakeIntercomPage(() => ({ body: { conversations: [{ id: 1 }] } }));
  const r = await runInFakePage(ic.callSource('/messenger/web/conversations'), top);
  const s = JSON.stringify(r);
  ok(!s.includes('JWTBUNDLE') && !s.includes('sess-uuid') && !s.includes('anon'));
});

test('intercom: refuses paths outside the allowlist, in the page', async () => {
  const { top, calls } = fakeIntercomPage(() => ({ body: {} }));
  const r = await runInFakePage(ic.callSource('/messenger/web/user_auth_tokens'), top);
  is(r.code, 'refused');
  is(calls.length, 0);
});

test('intercom: no messenger on the page', async () => {
  const { top } = fakeIntercomPage(() => ({ body: {} }), { hasMessenger: false });
  const r = await runInFakePage(ic.callSource('/messenger/web/conversations'), top);
  is(r.code, 'no-messenger');
});

test('intercom client: a 401 re-borrows the session once, then reports auth', async () => {
  let n = 0;
  const { top, calls } = fakeIntercomPage(() => (++n === 1 ? { status: 401, body: {} } : { body: { conversations: [] } }));
  const c = ic.makeClient((src) => runInFakePage(src, top));
  is(await c.conversations(), []);
  is(calls.length, 2);
  const { top: top2 } = fakeIntercomPage(() => ({ status: 401, body: {} }));
  let e = null;
  try { await ic.makeClient((src) => runInFakePage(src, top2)).conversations(); } catch (err) { e = err; }
  is(e && e.code, 'auth');
});

// Recorded 2026-11-09, trimmed.
const CONV = {
  id: '215000000000002',
  title: 'Slack mobile Link Preview Bug',
  state: 'state_closed',
  updated_at: 1794217207,
  conversation_parts: [
    { id: 'p1', part_type: 'comment', created_at: 1794217031, author: { type: 'widget_user', name: 'A User' }, blocks: [{ type: 'paragraph', text: 'shows &quot;&amp;amp;&quot; for R&amp;#x26;B' }] },
    { id: 'p2', part_type: 'comment', created_at: 1794217207, author: { type: 'Admin', name: 'Fin' }, blocks: [{ type: 'paragraph', text: 'Case #400000002 has been opened and is under review.' }] },
  ],
};

test('intercom: normalizeConversation flattens parts and decodes text', () => {
  const c = ic.normalizeConversation(CONV);
  is(c.open, false);
  is(c.canReply, false);
  is(c.messages.length, 2);
  is(c.messages[0].isUser, true);
  is(c.messages[0].text, 'shows "&amp;" for R&#x26;B');
  is(c.messages[1].from, 'Fin');
  is(c.updatedAt, '2026-11-09T09:40:07.000Z');
});

test('intercom: findCaseNumber reads Fin\'s confirmation', () => {
  is(ic.findCaseNumber('Case #400000002 has been opened and is under review.'), '400000002');
  is(ic.findCaseNumber('Your case number: 400000001'), '400000001');
  is(ic.findCaseNumber('I can connect you with a support engineer.'), null);
});

test('intercom: textToBlocks escapes and splits paragraphs', () => {
  is(ic.textToBlocks('a & <b>\nc\n\nd'), [{ type: 'paragraph', text: 'a &amp; &lt;b&gt;<br>c' }, { type: 'paragraph', text: 'd' }]);
});

test('intercom client: waitForReply waits for Fin to go quiet, then returns', async () => {
  const user = CONV.conversation_parts[0];
  const fin = (t, i) => ({ id: `f${i}`, part_type: 'comment', created_at: 1794217100 + i, author: { type: 'Admin', name: 'Fin' }, blocks: [{ type: 'paragraph', text: t }] });
  // Fin answers in three parts, one poll apart, then names the case. A quiet period
  // counted from Fin's FIRST part (the bug this guards) returns at t=3 s, before the case
  // number; counted from the latest part, it waits for it.
  const f1 = fin('Thanks, looking into it.', 1);
  const f2 = fin('Let me organize the information.', 2);
  const f3 = fin('Case #400000002 has been opened.', 3);
  const frames = [[user], [user, f1], [user, f1, f2], [user, f1, f2], [user, f1, f2, f3]];
  let i = 0;
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    // Each read of the conversation returns the next recorded frame.
    const c = ic.makeClient(async () => ({ ok: true, value: { ...CONV, state: 'state_open', conversation_parts: frames[Math.min(i++, frames.length - 1)] } }));
    const r = await c.waitForReply('215000000000002', { afterCount: 1, timeoutMs: 60000, intervalMs: 1000, quietMs: 2000, sleep: async (ms) => { clock += ms; } });
    is(r.messages.length, 4, 'waited until Fin went quiet');
    is(ic.findCaseNumber(r.messages[3].text), '400000002');
  } finally {
    Date.now = realNow;
  }
});

// ── support-args ─────────────────────────────────────────────────────────────

test('args: a bare flag never swallows free text', () => {
  const r = parseArgs(['comment', '400000002', '--confirm', 'hello', 'world']);
  is(r.sub, 'comment');
  is(r.pos, ['400000002', 'hello', 'world']);
  is(r.flags.confirm, true);
});

test('args: --name=value, --no-name, -h and --', () => {
  const r = parseArgs(['create', '--subject=A & B', '--no-comment', '-h', '--', '--not-a-flag']);
  is(r.flags.subject, 'A & B');
  is(r.flags.comment, false);
  is(r.flags.h, true);
  is(r.pos, ['--not-a-flag']);
});

test('args: boolFlag is strict, so a typo never authorizes a send', () => {
  is(boolFlag({ confirm: true }, 'confirm'), true);
  is(boolFlag({ confirm: 'false' }, 'confirm'), false);
  is(boolFlag({}, 'confirm'), false);
  let e = null;
  try { boolFlag({ confirm: 'maybe' }, 'confirm'); } catch (err) { e = err; }
  ok(e && /not a boolean/.test(e.message));
});
