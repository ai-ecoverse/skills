# Page-context fetch helpers

Use these when `fetch()` from Node is blocked by `Origin` checks, missing
cookies, or bot detection. They execute inside the open browser tab so the
request carries the real origin, real cookies, and a real User-Agent.

## `openApp(url)` — open or reuse a tab

```js
// helpers.jsh
export async function openApp(url) {
  const { stdout: list } = await exec(`playwright-cli list-tabs`);
  const existing = list.split('\n').find(l => l.includes(new URL(url).host));
  if (existing) {
    const m = existing.match(/targetId[: =]+([A-F0-9-]+)/);
    if (m) return m[1];
  }
  const { stdout } = await exec(`playwright-cli open ${url}`);
  const m = stdout.match(/targetId[: =]+([A-F0-9-]+)/);
  if (!m) throw new Error(`Could not parse targetId from: ${stdout}`);
  return m[1];
}
```

## `apiViaBrowser(tabId, path, opts)` — run fetch inside the tab

```js
export async function apiViaBrowser(tabId, path, opts = {}) {
  const body = opts.body ? JSON.stringify(opts.body) : null;
  const expr = `
    (async () => {
      const r = await fetch(${JSON.stringify(path)}, {
        method: ${JSON.stringify(opts.method || 'GET')},
        credentials: 'include',
        headers: ${JSON.stringify(opts.headers || { 'content-type': 'application/json' })},
        body: ${body ? JSON.stringify(body) : 'undefined'}
      });
      return { status: r.status, body: await r.text() };
    })()
  `;
  const { stdout } = await exec(`playwright-cli eval --tab=${tabId} ${JSON.stringify(expr)}`);
  return JSON.parse(stdout);
}
```

## Larger payloads — use `eval-file`

For multi-line scripts or payloads >4kB write the JS to a temp file and call
`playwright-cli eval-file --tab=$tabId script.js`. This avoids shell quoting
issues entirely.

## Always pass `--tab=<targetId>`

`playwright-cli eval` without `--tab` picks an arbitrary tab and will silently
target the wrong page once the user navigates. Capture the `targetId` once via
`openApp()` and reuse it for the lifetime of the `.jsh` invocation.
