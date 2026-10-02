// Pure helpers for sharepoint.jsh — kept free of sliccy: / browser I/O so the
// in-SLICC tst suite can import them without a live M365 session.

/**
 * True when `hostname` is a SharePoint Online (or preprod) tenant host.
 * Outlook / M365 launcher hosts are NOT SharePoint — they can share an MSAL
 * cache entry (strategy 1) but do not serve `/_layouts/15/sharepoint.aspx/*`.
 */
function isSharePointHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h.endsWith('.sharepoint.com') || h.endsWith('.sharepoint-df.com');
}

/**
 * Parse a SharePoint site URL (or `hostname:/path` shorthand) into the pieces
 * Graph's `/sites/{hostname}:{server-relative-path}` shorthand wants.
 * Throws on unparseable input (caller maps to cli.die / process.exit).
 */
function parseSiteUrl(input) {
  const s = String(input).trim();
  if (!/^https?:\/\//i.test(s) && s.includes(':')) {
    // already in "hostname:/path" form
    const [hostname, ...rest] = s.split(':');
    return { hostname, path: rest.join(':') || '' };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Could not parse SharePoint URL: ${input}`);
  }
  return { hostname: u.hostname, path: u.pathname.replace(/\/$/, '') };
}

/**
 * Build a Graph Search `queryString` scoped to one site.
 *
 * KQL `path:` expects a SharePoint URL (with a trailing `/` so similarly named
 * sites are not matched as a prefix — see Graph search-concept-files). A bare
 * Graph composite site id (`hostname,guid,guid`) must be resolved to `webUrl`
 * by the caller before invoking this.
 */
function buildScopedSearchQuery(query, siteWebUrl) {
  let scopeUrl = String(siteWebUrl || '').trim();
  if (!scopeUrl) {
    throw new Error('site webUrl is required to scope search');
  }
  if (!scopeUrl.endsWith('/')) scopeUrl += '/';
  return `${query} path:"${scopeUrl}"`;
}

module.exports = {
  isSharePointHostname,
  parseSiteUrl,
  buildScopedSearchQuery,
};
