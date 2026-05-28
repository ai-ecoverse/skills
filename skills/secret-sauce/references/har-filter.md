# HAR capture filter

Annotated filter expression for `playwright-cli record --filter=...`.

Drops static assets and analytics noise; keeps JSON / form / GraphQL / API-path
responses so the resulting HAR is small and easy to read.

```js
(e) => {
  // Only keep finished responses
  if (!e.response) return false;

  const url = (e.request && e.request.url) || '';
  const ct  = (e.response.headers && (e.response.headers['content-type'] || '')).toLowerCase();

  // Drop static assets
  if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|map)(\?|$)/i.test(url)) return false;

  // Drop common analytics / telemetry hosts
  if (/(google-analytics|googletagmanager|segment\.io|mixpanel|sentry\.io|amplitude|hotjar|fullstory)/i.test(url)) return false;

  // Keep JSON / GraphQL / form responses
  if (/application\/(json|graphql|x-www-form-urlencoded)/.test(ct)) return true;

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

For most cases the minimal one-liner shown in `SKILL.md` is enough; use this
full filter when the app emits a lot of analytics traffic or non-JSON RPC.
