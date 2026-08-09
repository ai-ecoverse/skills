---
name: secret-sauce
description: Reverse-engineer web app APIs and compile them into reusable site-specific skills with .jsh scripts. Use when the user wants to automate a web app, bypass slow UI interactions, create an API client for a website, set up webhooks to watch for changes in a web app, or build a durable integration with any SaaS tool. Activate whenever the user mentions automating a website, wants faster access to a web app, asks about watching for changes on a page, or says things like "I keep doing this manually" or "can you just call their API". Also use when the user has a HAR file they want analyzed, or when repeated playwright-cli interactions with the same site suggest an API skill would be more efficient.
allowed-tools: bash
---

# Secret Sauce

Turn any web app into a direct API integration. Discover the underlying API, validate it works, and compile the findings into a reusable site-specific skill with `.jsh` scripts.

## Discovery priority

1. **Known public API** — GitHub, Slack, Jira, Linear, Notion, etc. Dry-run a call with the user's session. Cheapest path.
2. **HAR capture** — `playwright-cli record` + filter, then extract API patterns from the recording.
3. **DOM observation** — Last resort: inject MutationObserver/PerformanceObserver via `playwright-cli eval-file`.

## Runtime constraints (critical)

SLICC fetch() routes through the browser Fetch API:
- Cookie headers are **silently stripped** — cannot be set on outbound requests
- Origin is always `http://localhost:...` — cannot be overridden
- User-Agent cannot be overridden

**Rule of thumb:** If the API is designed for third-party integrations (documented, uses API keys/PATs), use `fetch()` directly. If the API is the web app's own backend, use `playwright-cli eval` from the page context — it carries real cookies, correct origin, and full browser state.

`exec()` returns `{stdout, stderr, exitCode}`. Use it for `playwright-cli`, `webhook`, and other shell commands from .jsh scripts.

## Phase 1: Discovery

### Dry-run validation

**Token-based APIs:**
```bash
playwright-cli localstorage-list          # find JWTs/tokens
playwright-cli cookie-get auth_token      # or from cookies
node -e "(async () => {
  const r = await fetch('https://api.example.com/v1/me', {
    headers: { 'Authorization': 'Bearer TOKEN_HERE' }
  });
  console.log('Status:', r.status);
  if (r.ok) console.log(await r.json());
})()"
```

**Cookie-based APIs:**
```bash
# playwright-cli open prints human-readable output containing a targetId line.
# Parse the targetId before passing it to --tab:
tabId=$(playwright-cli open https://app.example.com | grep -oE 'targetId[: =]+[A-F0-9-]+' | grep -oE '[A-F0-9-]+$')
playwright-cli eval --tab=$tabId "
  fetch('/api/v1/me', { credentials: 'include' })
    .then(r => r.json()).then(d => JSON.stringify(d))
"
```

If 200 → move to Phase 4. If 401/403 → dig into auth. If 404 → HAR capture.

### HAR capture

```bash
# Paste the JS filter expression from references/har-filter.md in place of <FILTER>.
# Minimal working filter — headers are [{name,value},…] NOT a map; map lookup
# silently drops every entry and stop-recording leaves an empty directory.
playwright-cli record https://app.example.com --filter="(e) => { if (!e.response) return false; const hs=e.response.headers||[]; const ct=String((Array.isArray(hs)?(hs.find(h=>String(h.name||'').toLowerCase()==='content-type')||{}).value:hs['content-type'])||(e.response.content&&e.response.content.mimeType)||'').toLowerCase(); return /application\/(json|graphql)/.test(ct) || /\/(api|graphql|v\d+)\b/i.test((e.request&&e.request.url)||''); }"
```

The full annotated filter (drops static assets and analytics, keeps JSON/form/API-path responses, documents the header-shape pitfall) is in `references/har-filter.md`. Copy it verbatim for a more thorough capture.

After the first navigation, verify `/recordings/<recordingId>/` contains a non-empty `001-…-navigation-….har`. Empty dir = broken filter; fall back to unfiltered `playwright-cli record <url>` and filter offline.

Tell the user to perform the actions they want to automate, then:
```bash
playwright-cli stop-recording <recordingId>
```

**Extract from HAR:** URL pattern, HTTP method, required headers (especially CSRF tokens, custom headers on every request), auth mechanism, request/response schemas, pagination params, rate-limit headers.

For GraphQL: capture queries/mutations. If you see "No query with given identifier known," queries are pre-registered — extract the specific query IDs from the app's JS, or use the public REST API.

Check cookie domain scoping — a session cookie on `example.com` won't be sent to `api.example.com` unless the cookie domain is `.example.com`.

## Phase 2: Authentication

### Extract credentials

```bash
playwright-cli localstorage-list    # SPAs: access_token, id_token, jwt
playwright-cli cookie-list          # server-rendered: session cookies, CSRF tokens
playwright-cli sessionstorage-list
```

### Auth strategy

See `references/auth-strategies.md` for the full auth strategy table covering PAT/API key, Bearer/JWT, cookie-based session, Origin-validated API, CSRF token, and OAuth flows.

If session auth is impractical (cookies scoped to a different domain, locked-down GraphQL), ask the user to create a PAT in the app's settings. Store it at `/workspace/skills/{app-name}/.config`.

### Page-context fetch helper

See `references/page-context-helper.md` for the full `openApp()` and `apiViaBrowser()` helpers. Use these for Origin-validated or cookie-based APIs. Always pass `--tab=<targetId>`. For larger payloads use `playwright-cli eval-file` with a JS file.

### Handle token expiry

1. Make the API call. 2. If 401/403, re-extract credentials from the browser. 3. If browser session also expired, tell the user: "Session expired — please log into {app} in your browser, then try again." 4. Retry.

On 429: parse `Retry-After`, implement exponential backoff, log rate-limit status.

## Phase 3: Webhooks and observers

For "tell me when Y changes" tasks: `webhook create` → inject observer via `playwright-cli eval-file` → observer posts to webhook → scoop handles event → `.bsh` re-injects observer on navigation.

```bash
webhook create --scoop my-watcher --name app-changes \
  --filter "(e) => e.body.type === 'data-change'"
```

See `references/observers.md` for observer type selection (MutationObserver, PerformanceObserver, native webhooks/SSE, cron polling) and complete implementation patterns.

Observer scripts must be idempotent — guard with `if (window.__slicc_observer) return;`.

`.bsh` files are scanned every 30 seconds; first matching navigation after writing may take up to 30s to trigger.

## Phase 4: Compile the skill

### Output structure

```
skills/{app-name}/
├── SKILL.md                         # How to use this app's API
├── scripts/
│   ├── {app-name}.jsh               # Main API client
│   ├── auth.jsh                     # Auth helpers (if needed)
│   └── watch.jsh                    # Observer/webhook setup (if applicable)
├── references/
│   ├── endpoints.md                 # Discovered API endpoints
│   ├── auth-strategies.md           # Auth strategy table
│   ├── har-filter.md                # Full annotated HAR capture filter
│   ├── observers.md                 # Observer type selection and patterns
│   └── page-context-helper.md       # openApp() and apiViaBrowser() helpers
└── assets/
    ├── observer.js                  # Page-context observer (if applicable)
    └── -.{domain}.bsh               # Auto-injector (if applicable)
```

### .jsh script structure

A `.jsh` script should include: (1) tab management via `openApp()`, (2) auth extraction from localStorage/cookies, (3) direct `fetch()` or page-context `apiViaBrowser()` depending on the auth mechanism, and (4) a command dispatch block that maps CLI arguments to API operations. The filename without `.jsh` becomes the shell command name.

### Generated SKILL.md frontmatter

```yaml
---
name: {app-name}
description: Interact with {App Name} via its API — list, create, update, and
  delete {resources}. Use when the user wants to automate {App Name}, check
  {App Name} data, watch for changes in {App Name}, or perform any {App Name}
  task without clicking through the UI. Activate on mentions of {App Name},
  {common terms}, {resource types}, or related workflows.
allowed-tools: bash
---
```

Include the app name multiple times and list common action triggers to maximise routing accuracy.

### Validation checklist

1. Auth works — run a read-only API call via the .jsh script
2. Every subcommand works
3. 401 triggers re-auth message; 429 shows rate-limit info
4. The .jsh is callable as a shell command (filename without .jsh = command)
5. The SKILL.md description includes the app name and common action words

## Decision tree

Use this as the primary routing guide when starting a new automation task:

```
User wants to automate {app}
│
├─ Known public API with PAT/API key?
│  ├─ Yes → ask for PAT → fetch() with Authorization → dry-run → Phase 4
│  └─ No → guess endpoints or HAR capture
│
├─ API discovered — how does auth work?
│  ├─ fetch() → 200 → use fetch() in .jsh
│  ├─ fetch() → 401 (Origin rejected) → playwright-cli eval → 200 → use eval in .jsh
│  ├─ Cookie scoped to different domain → playwright-cli eval from page context
│  ├─ Pre-registered GraphQL → public REST API or extract query IDs from app JS
│  └─ Heavily protected → page-context eval or DOM observation
│
└─ Watch for changes?
   ├─ Yes → webhook + observer (see references/observers.md)
   └─ No → skip Phase 3
```

## Tips

- Name the generated skill after the app, not the task. `slack` not `slack-message-sender`. Cover the full API surface.
- Prefer observers over polling when the user keeps the tab open; use `crontask` when they don't.
