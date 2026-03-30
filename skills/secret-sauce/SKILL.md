---
name: secret-sauce
description: Reverse-engineer web app APIs and compile them into reusable site-specific skills with .jsh scripts. Use when the user wants to automate a web app, bypass slow UI interactions, create an API client for a website, set up webhooks to watch for changes in a web app, or build a durable integration with any SaaS tool. Activate whenever the user mentions automating a website, wants faster access to a web app, asks about watching for changes on a page, or says things like "I keep doing this manually" or "can you just call their API". Also use when the user has a HAR file they want analyzed, or when repeated playwright-cli interactions with the same site suggest an API skill would be more efficient.
allowed-tools: bash
---

# Secret Sauce

Turn any web app into a direct API integration. Instead of clicking through UIs with playwright-cli every time, discover the underlying API, validate it works, and compile the findings into a reusable site-specific skill with `.jsh` scripts.

## When to use this

You're interacting with a web app through the browser and realize you'll need to do this repeatedly. Or the user explicitly asks to automate a site. Or you notice yourself writing the same playwright-cli sequences over and over. That's when you stop clicking and start cooking.

## Mental model

Every web app is a frontend talking to an API. The frontend is the slow, fragile path. The API is the secret sauce — faster, more stable, more composable. This skill is about finding that API and bottling it.

The priority order for discovering the API surface:

1. **Known public API** — Many popular apps (GitHub, Slack, Jira, Linear, Notion, etc.) have documented APIs. The model already knows about these. A quick dry-run call confirms they work with the user's session. This is the cheapest path.

2. **Network capture** — Use `playwright-cli record` to capture HAR traffic while using the app normally. Filter, analyze, and extract the API patterns from the recording.

3. **DOM observation** — When the API surface is too complex or heavily protected, fall back to watching the DOM via `playwright-cli eval`. MutationObservers and PerformanceObservers injected into the page context can extract structured data. This is the last resort but always works.

## Runtime constraints

SLICC runs inside a browser. This creates specific constraints that affect how API clients work:

**fetch() and curl are browser-native.** Both route through the browser's Fetch API. This means:
- `Authorization: Bearer <token>` headers work perfectly
- `X-API-Key` and other custom headers work
- **Cookie headers are silently stripped** — the browser Fetch spec forbids setting `Cookie` on requests. This is not an error; the header is just removed.
- **Set-Cookie response headers are also stripped** — you can't capture session cookies from API responses
- **Origin is always `http://localhost:...`** — the browser sets Origin automatically and it can't be overridden. APIs that validate Origin (many do) will reject requests from localhost.
- `User-Agent` cannot be overridden (also a forbidden header)
- Requests include `Sec-Fetch-*` headers from the SLICC page

**Implication for auth strategy:** Even token-based auth may fail if the API validates the Origin header. In practice, **`playwright-cli eval` is the most reliable approach** for any API that serves a web app — it makes requests from the real page context with the correct origin, cookies, and all browser state. Direct fetch() from .jsh scripts works only when the API doesn't check Origin (public APIs, developer APIs with explicit token auth like GitHub's REST API with a PAT).

**Rule of thumb:** If the API is designed for third-party integrations (documented, uses API keys/PATs), fetch() works. If the API is the web app's own backend (discovered via HAR), use page-context fetch.

**exec() works reliably.** Returns `{stdout, stderr, exitCode}`. Use it to call `playwright-cli`, `webhook`, and other shell commands from .jsh scripts.

## Phase 1: Discovery

### Strategy: guess first, verify always

For well-known apps, you likely already know the API structure. Try the obvious endpoints first — but never assume they work. Every guess gets a dry-run validation before you move on.

#### Dry-run validation

The approach depends on the API's auth mechanism:

**For token-based APIs** (Bearer, API key) — use fetch() directly:

```bash
# Extract a token from localStorage (common for SPAs)
playwright-cli localstorage-list
# Or from cookies (the value, not the header)
playwright-cli cookie-get auth_token

# Test with fetch via node
node -e "
  const r = await fetch('https://api.example.com/v1/me', {
    headers: { 'Authorization': 'Bearer TOKEN_HERE' }
  });
  console.log('Status:', r.status);
  if (r.ok) console.log(await r.json());
"
```

**For cookie-based APIs** — use playwright-cli eval from within the page:

```bash
# Navigate to the app first (so cookies are in scope)
playwright-cli open https://app.example.com

# Make the API call from the page context where cookies are automatic
playwright-cli eval "
  fetch('/api/v1/me', { credentials: 'include' })
    .then(r => r.json())
    .then(d => JSON.stringify(d))
"
```

If the dry run returns 200, you've found the sauce. If 401/403, investigate auth further. If 404, the endpoint doesn't exist — move to HAR capture.

#### For unknown apps: HAR capture

When you can't guess the API, record the traffic:

```bash
# Start recording with a filter to keep only API-like requests
playwright-cli record https://app.example.com \
  --filter="(e) => {
    const url = e.request.url;
    if (/\.(js|css|png|jpg|svg|woff|ico|gif|webp)(\?|$)/i.test(url)) return false;
    if (/(google-analytics|segment|mixpanel|hotjar|doubleclick|sentry|datadog)/i.test(url)) return false;
    if (/\/(cdn|static|assets|fonts)\//i.test(url)) return false;
    const ct = (e.response?.headers || []).find(h => h.name.toLowerCase() === 'content-type');
    if (ct && /json|form|text\/plain/i.test(ct.value)) return true;
    if (/\/(api|v[0-9]|graphql|rest|rpc)\//i.test(url)) return true;
    return false;
  }"
```

Tell the user: "I've opened the app with recording enabled. Perform the actions you want to automate — browse, submit forms, whatever you normally do. Let me know when you're done."

When done:

```bash
playwright-cli stop-recording <recordingId>
# HAR files saved to /recordings/<recordingId>/
```

The HAR filter receives full HarEntry objects. The `e.request.url` is the URL string, `e.response.headers` is an array of `{name, value}` objects. The filter runs at save time (batched), not per-request, so you can use complex logic without slowing capture.

When writing filter expressions, err on keeping too much rather than filtering too aggressively. You can ignore irrelevant entries during analysis, but you can't recover filtered-out traffic.

### What to extract from a HAR

For each API endpoint found:

- **URL pattern** — base URL, path template (identify path parameters like `/users/{id}`)
- **HTTP method** — GET, POST, PUT, DELETE, PATCH
- **Required headers** — Authorization, CSRF tokens, custom headers (X-App-Token, etc.)
- **Auth mechanism** — Bearer token? Cookie-based? API key? Note where the credential comes from
- **Request body schema** — JSON structure, required vs optional fields
- **Response schema** — JSON structure, pagination markers, error format
- **Query parameters** — filtering, sorting, pagination params
- **Rate limit headers** — X-RateLimit-Remaining, Retry-After

Group related endpoints by resource (e.g., all `/users/*` endpoints together). Identify CRUD patterns.

For GraphQL apps, look for a single `/graphql` endpoint and capture different queries/mutations to map the schema. **Caveat:** Some apps (notably GitHub) use pre-registered query IDs — their internal GraphQL rejects arbitrary queries. If you see errors like "No query with given identifier known," the GraphQL is locked down and you'll need to extract the specific query IDs from the app's JavaScript, or use the public REST API instead.

Also check **cookie domain scoping** — a session cookie on `example.com` won't be sent to `api.example.com` unless the cookie domain is `.example.com`. This is a common reason why API calls fail from a different subdomain.

## Phase 2: Authentication and defenses

The user is already logged into the app in their browser. Leverage that session.

### Extracting auth credentials

Check these sources in order:

```bash
# 1. localStorage — SPAs often store JWTs/tokens here
playwright-cli localstorage-list
# Look for: access_token, id_token, auth, session, jwt

# 2. Cookies — most common for server-rendered apps
playwright-cli cookie-list
# Look for: session cookies, auth tokens, CSRF tokens

# 3. sessionStorage
playwright-cli sessionstorage-list
```

### Auth strategy by type

| Auth type | Detection | How to use in .jsh |
|-----------|-----------|-------------------|
| Personal access token (PAT) | User provides it, or app has a "tokens" settings page | Store in a config file, use in Authorization header via fetch() — this is the most reliable path for public APIs |
| Bearer/JWT in localStorage | Token in `localStorage` under key like `access_token` | Extract via `exec('playwright-cli localstorage-get KEY')`, use in Authorization header |
| Clerk/Auth0/Firebase JWT | `__session` cookie containing a JWT, audience claim pointing to an API | Extract via `exec('playwright-cli cookie-get __session')`, use as Bearer token — but check if Origin validation blocks direct fetch |
| API key in header | `X-API-Key` or similar in HAR | Pass as custom header in fetch() |
| Cookie-based session | `sessionid`, `connect.sid`, `PHPSESSID` in cookies | Use `playwright-cli eval` from page context |
| Origin-validated API | HAR shows Bearer auth, but direct fetch returns 401 while page-context fetch works | Use `playwright-cli eval` from page context — the API checks Origin |
| OAuth via `oauth-token` | Provider supported by SLICC's OAuth | Use `exec('oauth-token <provider>')` to get a fresh token |
| CSRF token | `X-CSRF-Token` header, `csrftoken` cookie | Extract from cookie, add as header on mutating requests |

### When to ask the user for a token

Some apps (GitHub, GitLab, Atlassian, etc.) have public APIs designed for third-party integrations that work with personal access tokens. If the session auth is impractical (cookies scoped to a different domain, internal GraphQL with pre-registered queries), the cleanest path is to ask the user to create a PAT in the app's settings and provide it. Store it in a config file at `/workspace/skills/{app-name}/.config` and read it from the .jsh script.

### Additional required headers

HAR analysis often reveals custom headers beyond auth that the API requires:
- **Anti-replay tokens** — e.g., `Browser-Token: {"token":"base64(timestamp)"}` — generate fresh on each request
- **Device/client IDs** — e.g., `Device-Id: <uuid>` — generate once and reuse
- **Challenge tokens** — Cloudflare Turnstile, reCAPTCHA — these are hard to replicate; prefer page-context approach

Always check the HAR for headers that appear on every API request. If the API rejects calls without them, replicate them in the generated skill.

### The page-context fetch pattern

Since fetch() can't send Cookie headers and the Origin is always localhost, many web-app APIs need requests made from within the page context. Use `playwright-cli eval` for this:

```javascript
// In a .jsh script — page-context API helper
// Note: playwright-cli always requires --tab in .jsh/.bsh scripts and in scoops.
// Capture the targetId when opening the tab and pass it to every command.

async function openApp(url) {
  const r = await exec(`playwright-cli open ${url}`);
  // Extract targetId from output like: "Opened ... [targetId: ABC123]"
  const match = r.stdout.match(/targetId:\s*(\S+)\]/);
  return match ? match[1] : null;
}

async function apiCall(tabId, path, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : undefined;
  
  // Build the eval expression — fetch runs in the page context with cookies
  const expr = `
    fetch('${path}', {
      method: '${method}',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ${body ? `body: ${JSON.stringify(body)},` : ''}
    }).then(r => r.json()).then(d => JSON.stringify(d))
  `;
  
  const result = await exec(`playwright-cli eval "${expr.replace(/"/g, '\\"')}" --tab=${tabId}`);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim());
}
```

For larger payloads or complex request logic, use `playwright-cli eval-file` with a JS file that contains the request code. Always pass `--tab=<targetId>`.

**Important:** `playwright-cli` commands (eval, snapshot, screenshot, goto, etc.) always require `--tab=<targetId>` when called from .jsh scripts or scoops. Only the cone's interactive shell auto-selects the current tab. Always capture the targetId from `playwright-cli open` output and thread it through your script.

### Handling token expiry

The generated skill should handle expired auth gracefully:

1. Make the API call
2. If 401/403, try to extract fresh credentials from the browser
3. If the browser session is also expired, tell the user: "Session expired — please log into {app} in your browser, then try again."
4. Retry the original call

### Rate limits and retry

If HAR analysis reveals rate limit headers:

- Parse `X-RateLimit-Remaining` and `Retry-After` from responses
- Implement exponential backoff on 429 responses
- Log rate limit status so the user knows what's happening

### Bot detection

Some apps have aggressive bot detection. Mitigation hierarchy:

1. **Use the user's session credentials** — requests that carry valid auth often bypass challenges
2. **Match browser headers from HAR** — replicate the exact request pattern the real app makes
3. **Fall back to page-context fetch** via `playwright-cli eval` — the request comes from the actual page
4. **Fall back to DOM** — use playwright-cli to read rendered data instead of calling APIs

## Phase 3: Webhooks and observers

Many automation tasks aren't "do X now" — they're "tell me when Y changes." SLICC can set up persistent watchers using webhooks + browser observers.

### Architecture

1. **Webhook endpoint** — `webhook create` gives you a URL that triggers a scoop
2. **Browser observer** — JavaScript injected into the page via `playwright-cli eval-file` that fires when something changes
3. **The observer calls the webhook** — which wakes up the scoop to handle the event
4. **A .bsh file re-injects observers on navigation** — so they survive page reloads

### Step 1: Create the webhook

```bash
webhook create --scoop my-watcher --name app-changes \
  --filter "(e) => e.body.type === 'data-change'"
```

Note the webhook URL from the output.

### Step 2: Write the observer injection script

Create a JS file that will be injected into the page context via `eval-file`. This code runs inside the target web app's page, so it has full access to the DOM, MutationObserver, PerformanceObserver, and the page's own cookies/fetch.

Example — `/shared/skills/{app-name}/assets/observer.js`:

```javascript
// Watch for new items in a list via DOM mutations
(() => {
  if (window.__slicc_observer) return; // prevent double-install
  window.__slicc_observer = true;
  
  const WEBHOOK_URL = '__WEBHOOK_URL__';
  
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Adapt selector to the target app
        const item = node.matches?.('.list-item') ? node : node.querySelector?.('.list-item');
        if (item) {
          fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'data-change',
              event: 'new-item',
              data: { text: item.textContent?.trim() }
            })
          }).catch(() => {}); // fire and forget
        }
      }
    }
  });
  
  const target = document.querySelector('.list-container');
  if (target) observer.observe(target, { childList: true, subtree: true });
})();
```

For network-level observation:

```javascript
(() => {
  if (window.__slicc_perf_observer) return;
  window.__slicc_perf_observer = true;
  
  const WEBHOOK_URL = '__WEBHOOK_URL__';
  
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.includes('/api/messages')) {
        fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'data-change',
            event: 'api-activity',
            data: { url: entry.name, duration: entry.duration }
          })
        }).catch(() => {});
      }
    }
  });
  po.observe({ type: 'resource', buffered: false });
})();
```

### Step 3: Write the .bsh auto-injector

A `.bsh` file re-injects the observer script whenever the user navigates to the app. The `.bsh` runs in SLICC's context (not the page), so it uses `exec()` to call `playwright-cli eval-file`.

Example — `/shared/-.app-name.com.bsh`:

```javascript
// @match *://*.app-name.com/*

// Find the tab that triggered this .bsh (it's the one that just navigated)
const list = await exec('playwright-cli tab-list');
const match = list.stdout.match(/\[([A-F0-9]+)\]\s+https?:\/\/[^\s]*app-name\.com/);
const tabId = match ? match[1] : null;

if (tabId) {
  const result = await exec(`playwright-cli eval-file /shared/skills/app-name/assets/observer.js --tab=${tabId}`);
  if (result.exitCode !== 0) {
    console.error('[BSH] Observer injection failed:', result.stderr);
  }
} else {
  console.error('[BSH] Could not find app tab');
}
```

Discovery note: `.bsh` files are scanned from `/workspace` and `/shared` every 30 seconds. After writing a new `.bsh`, the first matching navigation may take up to 30 seconds to trigger.

### Step 4: Handle webhook events in the scoop

The scoop specified in `webhook create --scoop` receives lick events when the webhook fires. The scoop should process the event data and take action (send a notification, update a file, call another API, etc.).

### Observer type selection

| Observer | Best for | How to use |
|----------|----------|------------|
| MutationObserver | New items in lists, DOM changes, UI state changes | Inject via eval-file, watch specific container elements |
| PerformanceObserver | Detecting API calls, monitoring fetch/XHR activity | Inject via eval-file, filter by URL pattern |
| Native app webhooks/SSE | Apps that support push (GitHub, Slack, etc.) | Register webhook URL directly with the app's API |
| Cron-based polling | Periodic checks when user doesn't keep tab open | `crontask create` + scoop that calls the API on each tick |

### Cron-based polling fallback

When the user doesn't keep the app tab open:

```bash
crontask create --name check-app --scoop app-watcher \
  --cron "*/5 * * * *"
```

The scoop runs the API call on each tick and compares with the previous state.

## Phase 4: Compile the skill

Once you've validated the API endpoints, auth mechanism, and any observers — compile everything into a new site-specific skill.

### Output structure

```
skills/{app-name}/
├── SKILL.md              # How to use this app's API
├── scripts/
│   ├── {app-name}.jsh    # Main API client (callable as shell command)
│   ├── auth.jsh          # Auth extraction/refresh helpers (if needed)
│   └── watch.jsh         # Observer/webhook setup (if applicable)
├── references/
│   └── endpoints.md      # Discovered API endpoints documentation
└── assets/
    ├── observer.js        # Page-context observer script (if applicable)
    └── -.{domain}.bsh    # Auto-injector for observers (if applicable)
```

### Writing the SKILL.md

The generated SKILL.md needs proper YAML frontmatter and structured content so that the SLICC agent can discover and use it effectively.

**Frontmatter:**

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

Make the description "pushy" — include the app name multiple times and list common triggers so the skill activates reliably.

**Body structure:**

```markdown
# {App Name}

Direct API access to {App Name}. Use the bundled `.jsh` scripts instead of
clicking through the browser UI.

## Quick start

[Show the 2-3 most common operations as copy-pasteable commands]

## Authentication

[Explain where the auth token lives, how to extract it, and what to do when it expires.
Be specific: "Token is stored in localStorage under `auth_token`" not "extract the token".]

## Available commands

### {app-name} list [options]
[What it does, what arguments it takes, example output]

### {app-name} get <id>
[...]

### {app-name} create <json>
[...]

## Watching for changes

[If observers are set up, explain how they work and how to enable/disable them.
Reference the .bsh and observer.js files.]

## Endpoints reference

For the full endpoint list with request/response schemas, see
`references/endpoints.md`.
```

### Writing .jsh scripts

Generated `.jsh` scripts should follow this pattern:

```javascript
#!/usr/bin/env jsh
// {App Name} API client — generated by secret-sauce

const APP_DOMAIN = '{domain}';
const BASE_URL = '{base_url}';

// --- Tab management ---
// playwright-cli requires --tab=<targetId> in .jsh scripts.
// We find an existing app tab or open one.

let _tabId = null;

async function ensureTab() {
  if (_tabId) return _tabId;
  
  // Check if the app is already open
  const list = await exec('playwright-cli tab-list');
  const match = list.stdout.match(new RegExp(`\\[([A-F0-9]+)\\]\\s+https?://[^\\s]*${APP_DOMAIN}`));
  if (match) {
    _tabId = match[1];
    return _tabId;
  }
  
  // Open the app
  const r = await exec(`playwright-cli open https://${APP_DOMAIN}`);
  const m = r.stdout.match(/targetId:\s*(\S+)\]/);
  _tabId = m ? m[1] : null;
  if (!_tabId) { console.error('Failed to open app tab'); process.exit(1); }
  
  // Wait for page to load
  await new Promise(r => setTimeout(r, 2000));
  return _tabId;
}

// --- Auth ---

async function getAuth() {
  // Token-based: extract from localStorage or cookies
  const tabId = await ensureTab();
  const r = await exec(`playwright-cli localstorage-get access_token --tab=${tabId} 2>/dev/null`);
  const token = r.stdout.trim();
  if (token && token !== 'null' && token !== 'undefined') {
    return { Authorization: `Bearer ${token}` };
  }
  
  // Fallback: try cookie
  const r2 = await exec(`playwright-cli cookie-get auth_token --tab=${tabId} 2>/dev/null`);
  const cookieToken = r2.stdout.trim();
  if (cookieToken) {
    return { Authorization: `Bearer ${cookieToken}` };
  }
  
  console.error(`No auth found. Log into ${APP_DOMAIN} in your browser and try again.`);
  process.exit(1);
}

// --- API (direct fetch — for APIs that accept any Origin) ---

async function api(method, path, body) {
  const headers = await getAuth();
  headers['Content-Type'] = 'application/json';
  headers['Accept'] = 'application/json';
  
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  
  const resp = await fetch(`${BASE_URL}${path}`, opts);
  
  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After') || '5';
    console.error(`Rate limited. Retry after ${retryAfter}s.`);
    process.exit(1);
  }
  
  if (resp.status === 401 || resp.status === 403) {
    console.error(`Auth failed (${resp.status}). Log into ${APP_DOMAIN} in your browser and try again.`);
    process.exit(1);
  }
  
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`API error ${resp.status}: ${text}`);
    process.exit(1);
  }
  
  return resp.json();
}

// --- API via page context (for Origin-validated or cookie-based APIs) ---

async function apiViaBrowser(path, options = {}) {
  const tabId = await ensureTab();
  const method = options.method || 'GET';
  const bodyStr = options.body ? JSON.stringify(options.body) : 'undefined';
  const expr = `
    (async()=>{
      const r = await fetch('${BASE_URL}${path}', {
        method: '${method}',
        credentials: 'include',
        headers: {'Content-Type':'application/json'},
        body: ${bodyStr}
      });
      if (!r.ok) return JSON.stringify({__error: r.status, detail: await r.text()});
      return JSON.stringify(await r.json());
    })()
  `.replace(/\n/g, ' ').replace(/"/g, '\\"');
  
  const result = await exec(`playwright-cli eval "${expr}" --tab=${tabId}`);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.__error) throw new Error(`API error ${parsed.__error}: ${parsed.detail}`);
  return parsed;
}

// --- Commands ---

const [,, cmd, ...args] = process.argv;

const commands = {
  async list() {
    const data = await api('GET', '/items');
    return data;
  },
  async get(id) {
    if (!id) { console.error('Usage: {app-name} get <id>'); process.exit(1); }
    return api('GET', `/items/${id}`);
  },
  async create(...jsonParts) {
    const body = JSON.parse(jsonParts.join(' '));
    return api('POST', '/items', body);
  },
};

if (!cmd || cmd === 'help' || !commands[cmd]) {
  console.log('Usage: {app-name} <command> [args]');
  console.log('Commands:', Object.keys(commands).join(', '));
  process.exit(cmd === 'help' ? 0 : 1);
}

const result = await commands[cmd](...args);
console.log(JSON.stringify(result, null, 2));
```

### Writing endpoints.md

The `references/endpoints.md` file should document every discovered endpoint:

```markdown
# {App Name} API Endpoints

Base URL: `{base_url}`
Auth: Bearer token from localStorage key `access_token`

## Items

### GET /items
List all items. Supports pagination via `?page=N&per_page=M`.

**Response:**
{json example}

### POST /items
Create a new item.

**Request body:**
{json schema with required/optional fields}

### GET /items/:id
Get a single item.

### PUT /items/:id
Update an item. Partial updates supported.

### DELETE /items/:id
Delete an item. Returns 204 on success.
```

### Validation

Before the skill is done, verify:

1. **Auth works** — run a simple read-only API call via the .jsh script
2. **Each command works** — test every subcommand in the .jsh
3. **Error handling works** — confirm 401 triggers the re-auth message, 429 shows rate limit info
4. **The .jsh is callable as a shell command** — the filename (without .jsh) becomes the command
5. **The SKILL.md description triggers properly** — include the app name and common action words

## Decision tree

```
User wants to automate {app}
│
├─ Is there a known public API with PAT/API key support?
│  ├─ Yes (GitHub, GitLab, Atlassian, etc.)
│  │  ├─ Ask user for PAT → use fetch() with Authorization header
│  │  ├─ Dry-run → works → skip to Phase 4
│  │  └─ No PAT available → try session-based approach below
│  │
│  └─ Not a well-known API → check if model can guess endpoints
│     ├─ Confident guess → dry-run from page context via eval
│     └─ No idea → HAR capture (Phase 1)
│
├─ HAR capture or guess reveals API?
│  ├─ Dry-run via fetch() → 200 → great, use fetch() in .jsh
│  ├─ Dry-run via fetch() → 401 (Origin rejected)
│  │  └─ Dry-run via page-context eval → 200 → use eval pattern in .jsh
│  ├─ Cookie-scoped to different domain → page-context eval
│  ├─ Pre-registered GraphQL → use public REST API or extract query IDs
│  └─ Heavily protected (Turnstile, captcha) → page-context eval or DOM
│
└─ Does the user need to watch for changes?
   ├─ Yes → set up webhook + observer
   │  ├─ API supports webhooks/SSE → register webhook URL natively
   │  ├─ Network observable → PerformanceObserver via eval-file
   │  ├─ DOM observable → MutationObserver via eval-file
   │  └─ Tab not always open → cron-based polling
   └─ No → skip Phase 3
```

## Tips

- Start cheap. A known API with a dry-run is minutes of work. HAR capture is an order of magnitude more. DOM scraping is the most fragile.
- The user's browser session is the golden ticket. Most challenges have already been solved by the user logging in normally.
- Name the generated skill after the app, not the task. `slack` not `slack-message-sender`. Cover the full API surface.
- For cookie-based APIs, always provide the `apiViaBrowser()` helper that uses `playwright-cli eval`. Document clearly in the generated SKILL.md which auth approach is used.
- When the user keeps the app tab open, prefer observers over polling. When they don't, use crontask.
- Observer scripts should be idempotent — check `window.__slicc_observer` before installing, so re-injection on navigation doesn't create duplicates.
