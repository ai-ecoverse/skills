# Observers and change-watching

For "tell me when Y changes" tasks. Pick the cheapest observer that still
reliably fires when the change happens.

## Observer selection

| Signal you can observe          | Use this                              | Notes                                          |
|---------------------------------|---------------------------------------|------------------------------------------------|
| App exposes webhooks / SSE      | Native webhook / `EventSource`        | Always preferred; survives tab close           |
| Background network requests     | `PerformanceObserver` (`resource`)    | Fires on every XHR/fetch; filter by URL        |
| DOM nodes appear / change       | `MutationObserver`                    | Cheap if scoped to a specific container        |
| None of the above; tab closed   | `crontask` polling the API            | Last resort, costs API quota                   |

## Webhook + observer flow

1. `webhook create --scoop my-watcher --name app-changes --filter "(e) => e.body.type === 'data-change'"`
2. Inject an observer into the tab via `playwright-cli eval-file observer.js`.
3. The observer `fetch()`es the webhook URL with `{ type, data }` whenever it
   detects a change.
4. A `-.{domain}.bsh` file in the skill's `assets/` re-injects the observer
   after navigation. `.bsh` files are scanned every ~30 s.

## Observer skeleton (`assets/observer.js`)

```js
if (window.__slicc_observer) {
  // already injected — idempotent guard
} else {
  window.__slicc_observer = true;

  const WEBHOOK_URL = 'https://…/scoop/my-watcher';
  const post = (type, data) =>
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, data })
    }).catch(() => { /* swallow — observer must never throw */ });

  // MutationObserver example
  const target = document.querySelector('[data-feed]');
  if (target) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.matches?.('[data-item]')) {
            post('data-change', { id: node.dataset.id, html: node.outerHTML });
          }
        }
      }
    }).observe(target, { childList: true, subtree: true });
  }

  // PerformanceObserver example
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.includes('/api/v1/items')) {
        post('api-call', { url: entry.name, duration: entry.duration });
      }
    }
  }).observe({ type: 'resource', buffered: false });
}
```

## Re-injection (`assets/-.{domain}.bsh`)

```bash
# Re-inject the observer on every navigation to this domain.
playwright-cli eval-file --tab=$SLICC_TAB_ID assets/observer.js
```

## Caveats

- Always guard with `if (window.__slicc_observer) return;` — `.bsh` may fire
  multiple times for the same page.
- Observers post to the webhook with `fetch()`; if the page has a strict CSP
  that blocks the webhook host, fall back to `navigator.sendBeacon` or
  `postMessage` to a trusted iframe.
- For polling fallbacks, prefer `crontask` over `setInterval` so the schedule
  survives the tab being closed.
