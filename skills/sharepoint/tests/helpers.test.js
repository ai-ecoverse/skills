import test, { is, ok, throws } from 'tst';
import {
  isSharePointHostname,
  parseSiteUrl,
  buildScopedSearchQuery,
} from '../scripts/helpers.js';

// ─── isSharePointHostname ─────────────────────────────────────────────────────

test('isSharePointHostname accepts tenant SPO hosts', () => {
  ok(isSharePointHostname('contoso.sharepoint.com'));
  ok(isSharePointHostname('contoso.sharepoint-df.com'));
  ok(isSharePointHostname('Contoso.SharePoint.Com'));
});

test('isSharePointHostname rejects Outlook / M365 / bare hosts', () => {
  is(isSharePointHostname('outlook.office.com'), false);
  is(isSharePointHostname('outlook.cloud.microsoft'), false);
  is(isSharePointHostname('office.com'), false);
  is(isSharePointHostname('myapps.microsoft.com'), false);
  is(isSharePointHostname('sharepoint.com'), false); // no tenant prefix
  is(isSharePointHostname(''), false);
  is(isSharePointHostname(null), false);
});

// ─── parseSiteUrl ─────────────────────────────────────────────────────────────

test('parseSiteUrl splits an https site URL', () => {
  is(parseSiteUrl('https://contoso.sharepoint.com/sites/Marketing'), {
    hostname: 'contoso.sharepoint.com',
    path: '/sites/Marketing',
  });
});

test('parseSiteUrl strips a trailing slash on the path', () => {
  is(parseSiteUrl('https://contoso.sharepoint.com/sites/Marketing/'), {
    hostname: 'contoso.sharepoint.com',
    path: '/sites/Marketing',
  });
});

test('parseSiteUrl accepts hostname:/path shorthand', () => {
  is(parseSiteUrl('contoso.sharepoint.com:/sites/Marketing'), {
    hostname: 'contoso.sharepoint.com',
    path: '/sites/Marketing',
  });
});

test('parseSiteUrl resolves a tenant root (no /sites path)', () => {
  is(parseSiteUrl('https://contoso.sharepoint.com'), {
    hostname: 'contoso.sharepoint.com',
    path: '',
  });
});

test('parseSiteUrl throws on garbage input', () => {
  throws(() => parseSiteUrl('not a url'), /Could not parse SharePoint URL/);
});

// ─── buildScopedSearchQuery ───────────────────────────────────────────────────
//
// Graph KQL path: needs a SharePoint URL with a trailing slash so similarly
// named sites are not matched as a prefix (search-concept-files). Passing a
// Graph composite site id here would silently fail to scope — callers must
// resolve webUrl first (covered by the jsh cmdSearch path).

test('buildScopedSearchQuery appends path: with a trailing slash', () => {
  is(
    buildScopedSearchQuery('budget 2026', 'https://contoso.sharepoint.com/sites/Marketing'),
    'budget 2026 path:"https://contoso.sharepoint.com/sites/Marketing/"'
  );
});

test('buildScopedSearchQuery does not double the trailing slash', () => {
  is(
    buildScopedSearchQuery('q', 'https://contoso.sharepoint.com/sites/Marketing/'),
    'q path:"https://contoso.sharepoint.com/sites/Marketing/"'
  );
});

test('buildScopedSearchQuery rejects an empty webUrl', () => {
  throws(() => buildScopedSearchQuery('q', ''), /webUrl is required/);
  throws(() => buildScopedSearchQuery('q', null), /webUrl is required/);
});
