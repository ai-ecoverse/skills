# HAR capture filter

Annotated filter expression for `playwright-cli record --filter=...`.

Drops static assets and analytics noise; keeps JSON / form / GraphQL / API-path
responses so the resulting HAR is small and easy to read.

## Critical: header shape

Playwright HAR (and the live filter event) exposes `response.headers` as an
**array of `{name, value}`**, not a plain object. This is wrong and yields an
empty recording:

```js
// BROKEN — always undefined on real HARs
e.response.headers['content-type']
```

Always resolve content-type through a small helper (see `hdr()` below). Also
fall back to `response.content.mimeType` when present.

If a filter throws or rejects every entry, `stop-recording` writes an **empty
directory** — treat that as a broken filter, not "the site had no API traffic."
Verify mid-flight with `ls /recordings/<id>/` after the first navigation; a
working capture produces `001-…-navigation-….har` chunks as you browse.

```js
(e) => {
  // Only keep finished responses
  if (!e.response) return false;

  const url = (e.request && e.request.url) || '';
  const headers = e.response.headers || [];

  // headers is [{name, value}, …] in HAR / CDP-derived events — NOT a map.
  const hdr = (n) => {
    const want = String(n).toLowerCase();
    if (Array.isArray(headers)) {
      const h = headers.find((x) => String(x.name || '').toLowerCase() === want);
      return (h && h.value) || '';
    }
    if (headers && typeof headers === 'object') {
      return headers[n] || headers[want] || '';
    }
    return '';
  };

  const ct = String(
    hdr('content-type') ||
      (e.response.content && e.response.content.mimeType) ||
      ''
  ).toLowerCase();

  // Drop static assets
  if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|map)(\?|$)/i.test(url)) return false;

  // Drop common analytics / telemetry hosts
  if (
    /(google-analytics|googletagmanager|googleadservices|doubleclick|segment\.io|mixpanel|sentry\.io|amplitude|hotjar|fullstory|clarity\.ms|facebook\.net|tiktok|redditstatic|reddit\.com|linkedin\.com\/px|datadoghq|taboola|outbrain)/i.test(
      url
    )
  )
    return false;

  // Keep JSON / GraphQL / form responses
  if (/application\/(json|graphql|x-www-form-urlencoded|manifest\+json)/.test(ct)) return true;

  // Keep typical API paths regardless of content-type
  if (/\/(api|graphql|v\d+|rest)\b/i.test(url)) return true;

  return false;
}
```

## Usage

```bash
# Copy the filter into a single line (or use a heredoc) and pass via --filter.
playwright-cli record https://app.example.com --filter="$(cat references/har-filter.md | sed -n '/^```js$/,/^```$/p' | sed '1d;$d')"
```

After the first full navigation, confirm capture:

```bash
ls -la /recordings/<recordingId>/
# expect 001-…-navigation-….har with non-zero size
```

If the directory stays empty, drop `--filter` (unfiltered always works) and
filter the HAR offline, or fix `hdr()` — do not keep browsing into a dead
recorder.

For most cases the minimal one-liner in `SKILL.md` is enough; use this full
filter when the app emits a lot of analytics traffic or non-JSON RPC.
