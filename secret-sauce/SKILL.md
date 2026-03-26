---
name: secret-sauce
description: Reverse-engineer web app APIs and compile them into reusable site-specific skills with .jsh scripts. Use when the user wants to automate a web app, bypass slow UI interactions, create an API client for a website, set up webhooks to watch for changes in a web app, or build a durable integration with any SaaS tool. Activate whenever the user mentions automating a website, wants faster access to a web app, asks about watching for changes on a page, or says things like "I keep doing this manually" or "can you just call their API". Also use when the user has a HAR file they want analyzed, or when repeated playwright-cli interactions with the same site suggest an API skill would be more efficient.
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

3. **DOM observation** — When the API surface is too complex or heavily protected, fall back to watching the DOM. MutationObservers, PerformanceObservers, and custom event listeners can extract structured data from the rendered page. This is the last resort but always works.

## Phase 1: Discovery

### Strategy: guess first, verify always

For well-known apps, you likely already know the API structure. Try the obvious endpoints first — but never assume they work. Every guess gets a dry-run validation before you move on.

#### Dry-run validation

Use the user's existing browser session to test API calls. Extract auth credentials from the browser context, then make a real request:

```bash
# Extract a token from cookies or localStorage
playwright-cli cookie-list
playwright-cli localstorage-list

# Try a lightweight API call with curl
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Cookie: $COOKIES" \
  "https://api.example.com/v1/me"
```

If the dry run returns 200, you've found the sauce. If it returns 401/403, you need to investigate auth further. If 404, the endpoint doesn't exist — move to HAR capture.

When using `curl` for dry runs, remember that SLICC runs in a browser sandbox. The `curl` command is available but requests are proxied. For cookie-based auth, extract cookies from `playwright-cli cookie-list` and pass them explicitly. For token-based auth, extract tokens from cookies or localStorage.

#### For unknown apps: HAR capture

When you can't guess the API, record the traffic:

```bash
# Start recording with a filter to reduce noise
# The filter removes static assets, analytics, and CDN requests
playwright-cli record https://app.example.com \
  --filter="(e) => {
    const url = e.request.url;
    const skip = /\.(js|css|png|jpg|svg|woff|ico|gif|webp)(\?|$)/i.test(url)
      || /(google-analytics|segment|mixpanel|hotjar|doubleclick|sentry|datadog)/i.test(url)
      || /\/(cdn|static|assets|fonts)\//i.test(url);
    if (skip) return false;
    // Keep only requests with JSON or form responses
    const ct = (e.response?.headers || []).find(h => h.name.toLowerCase() === 'content-type');
    if (ct && /json|form|text\/plain/i.test(ct.value)) return true;
    // Keep XHR/fetch requests that look like API calls
    if (/\/(api|v[0-9]|graphql|rest|rpc)\//i.test(url)) return true;
    return false;
  }"
```

Then tell the user: "I've opened the app with recording enabled. Go ahead and perform the actions you want to automate — browse around, submit forms, whatever you'd normally do. Let me know when you're done and I'll analyze the traffic."

When the user is done:

```bash
playwright-cli stop-recording <recordingId>
```

The HAR file is saved to `/recordings/<recordingId>/`. Analyze it to extract API endpoints, auth patterns, request/response schemas, and pagination.

### What to extract from a HAR

For each API endpoint found:

- **URL pattern** — base URL, path template (identify path parameters like `/users/{id}`)
- **HTTP method** — GET, POST, PUT, DELETE, PATCH
- **Required headers** — Authorization, CSRF tokens, custom headers (X-App-Token, etc.)
- **Request body schema** — JSON structure, required vs optional fields
- **Response schema** — JSON structure, pagination markers, error format
- **Query parameters** — filtering, sorting, pagination params
- **Rate limit headers** — X-RateLimit-Remaining, Retry-After, etc.

Group related endpoints by resource (e.g., all `/users/*` endpoints together). Identify CRUD patterns.

## Phase 2: Authentication and defenses

The user is already logged into the app in their browser. Leverage that session rather than asking for API keys.

### Extracting auth from the browser

Check these sources in order:

```bash
# 1. Cookies — most common for web apps
playwright-cli cookie-list
# Look for: session cookies, auth tokens, CSRF tokens

# 2. localStorage — SPAs often store JWTs here
playwright-cli localstorage-list
# Look for: access_token, id_token, auth, session

# 3. sessionStorage — some apps use this
playwright-cli sessionstorage-list
```

### Common auth patterns

| Pattern | How to detect | How to use |
|---------|--------------|------------|
| Session cookie | `Set-Cookie` with `sessionid`, `connect.sid`, `_session` | Pass cookie header with requests |
| Bearer/JWT | `Authorization: Bearer ...` in HAR, or token in localStorage | Add `Authorization` header |
| CSRF token | `X-CSRF-Token` header, `csrftoken` cookie, hidden form field | Extract from cookie/page, add to mutation requests |
| API key in header | `X-API-Key`, `X-App-Token` custom headers | Copy header to requests |
| OAuth token | Token endpoint in HAR, `access_token` in response | Use token, implement refresh if available |

### Handling token expiry

The generated skill should include re-authentication logic. The typical pattern:

1. Try the API call
2. If 401/403, extract fresh credentials from the browser
3. If the browser session is also expired, ask the user to log in again
4. Retry the original call

For the generated `.jsh` script, this looks like:

```javascript
async function ensureAuth(domain) {
  // Try existing token first
  let token = await getStoredToken(domain);
  if (token && await testToken(domain, token)) return token;
  
  // Extract fresh token from browser
  token = await extractTokenFromBrowser(domain);
  if (token && await testToken(domain, token)) {
    await storeToken(domain, token);
    return token;
  }
  
  // Ask user to log in
  console.log(`Session expired. Please log into ${domain} in your browser, then try again.`);
  process.exit(1);
}
```

### CSRF tokens

Many apps require CSRF tokens for POST/PUT/DELETE. The generated skill should:

1. Check if the app uses CSRF protection (look for `csrf`, `xsrf`, `_token` in cookies or headers)
2. Extract the token from the cookie (many frameworks set a `csrftoken` or `XSRF-TOKEN` cookie)
3. Send it as a header (`X-CSRFToken`, `X-XSRF-TOKEN`) on mutating requests

### Rate limits and retry

If HAR analysis reveals rate limit headers, the generated skill should respect them:

- Parse `X-RateLimit-Remaining` and `Retry-After` headers
- Implement exponential backoff on 429 responses
- Log rate limit status so the user knows what's happening

### Bot detection and captchas

Some apps have aggressive bot detection. Signs: 403 with challenge page, Cloudflare interstitial, reCAPTCHA.

Mitigation hierarchy:
1. **Use browser session cookies** — requests that carry the user's cookies often bypass bot detection because the user already passed the challenge
2. **Match browser headers** — use the exact User-Agent, Accept, and other headers from the HAR capture
3. **Fall back to DOM** — if direct API calls keep getting blocked, the generated skill should use playwright-cli as the transport layer instead of curl/fetch, reading data from the rendered page

## Phase 3: Webhooks and observers

This is SLICC's unique capability. Many automation tasks aren't "do X right now" — they're "tell me when Y changes." SLICC can set up persistent watchers.

### The webhook + observer pattern

The architecture:

1. **Create a webhook endpoint** — this gives you a URL that triggers a scoop
2. **Install a browser observer** — a `.bsh` script that fires when something changes
3. **The observer calls the webhook** — which wakes up the scoop to handle the event

#### Step 1: Create the webhook

```bash
webhook create --scoop my-watcher --name app-changes \
  --filter "(e) => e.body.type === 'data-change'"
```

#### Step 2: Write a .bsh observer

`.bsh` files auto-execute when the browser navigates to a matching URL. The filename is the hostname pattern.

Example: `-.slack.com.bsh` (matches any Slack subdomain)

```javascript
// @match *://*.slack.com/client/*

// Watch for new messages via DOM mutations
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.querySelector?.('.c-message_kit__text')) {
        const text = node.querySelector('.c-message_kit__text').textContent;
        const channel = document.querySelector('[data-qa="channel_name"]')?.textContent;
        
        fetch('WEBHOOK_URL', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'data-change',
            source: 'slack',
            event: 'new-message',
            data: { channel, text }
          })
        });
      }
    }
  }
});

observer.observe(
  document.querySelector('.p-workspace__primary_view'),
  { childList: true, subtree: true }
);
```

#### Step 3: Network observers (PerformanceObserver)

For catching API responses without DOM parsing:

```javascript
// Watch for network requests matching a pattern
const po = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.name.includes('/api/conversations.history')) {
      // A Slack API call just completed — new data may be available
      fetch('WEBHOOK_URL', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'data-change',
          source: 'slack',
          event: 'api-call',
          data: { url: entry.name, duration: entry.duration }
        })
      });
    }
  }
});
po.observe({ type: 'resource', buffered: false });
```

#### When to use which observer

| Observer type | Best for | Limitations |
|--------------|----------|-------------|
| MutationObserver | Visible UI changes, new items in lists | DOM structure can change between app versions |
| PerformanceObserver | Detecting API calls, monitoring network | Can't see response bodies, only URLs and timing |
| addEventListener (custom events) | Apps that emit custom events | App-specific, may not exist |
| Polling via crontask | Periodic checks, apps without push | Not real-time, uses more resources |

### Cron-based polling fallback

When observers aren't practical (the user doesn't keep the tab open), use `crontask` to poll:

```bash
crontask create --name check-jira --scoop jira-watcher \
  --cron "*/5 * * * *"
```

The scoop then runs the API call on each tick and compares with the previous state.

## Phase 4: Compile the skill

Once you've validated the API endpoints, auth mechanism, and any observers — compile everything into a new site-specific skill.

### Output structure

```
skills/{app-name}/
├── SKILL.md              # How to use this app's API
├── scripts/
│   ├── api.jsh            # Main API client (callable as shell command)
│   ├── auth.jsh           # Auth extraction/refresh helpers
│   └── watch.jsh          # Observer/webhook setup (if applicable)
├── references/
│   ├── endpoints.md       # Discovered API endpoints documentation
│   └── schemas.md         # Request/response schemas
└── assets/
    └── {app-name}.bsh     # Browser observer script (if applicable)
```

### Writing the SKILL.md

The generated SKILL.md should contain:

1. **Frontmatter** — name and description tuned for triggering (include the app name, common actions, and related terms)
2. **Quick start** — show the 2-3 most common operations
3. **Authentication** — how auth works for this app, how to refresh
4. **Available commands** — what the bundled `.jsh` scripts do
5. **Endpoints reference** — point to `references/endpoints.md` for the full list
6. **Watching for changes** — if observers are set up, explain how to use them

### Writing .jsh scripts

The generated `.jsh` scripts should:

- Use `fetch()` for HTTP requests (available in the SLICC runtime)
- Accept command-line arguments via `process.argv`
- Output JSON to stdout for composability with other commands
- Handle auth extraction from the browser automatically
- Include error handling with clear messages
- Respect rate limits

Example skeleton for a generated `api.jsh`:

```javascript
#!/usr/bin/env jsh
// {App Name} API client
// Generated by secret-sauce

const DOMAIN = '{domain}';
const BASE_URL = '{base_url}';

// --- Auth ---
async function getAuth() {
  // Extract auth from browser session
  const r = await exec(`playwright-cli cookie-list 2>/dev/null`);
  const cookies = r.stdout.trim();
  // Parse and return relevant auth headers
  // (implementation depends on the app's auth pattern)
  return { Cookie: cookies };
}

// --- API helpers ---
async function api(method, path, body) {
  const headers = await getAuth();
  headers['Content-Type'] = 'application/json';
  
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  
  const resp = await fetch(`${BASE_URL}${path}`, opts);
  
  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After') || '5';
    console.error(`Rate limited. Retry after ${retryAfter}s`);
    process.exit(1);
  }
  
  if (resp.status === 401 || resp.status === 403) {
    console.error(`Auth failed. Please log into ${DOMAIN} in your browser and try again.`);
    process.exit(1);
  }
  
  if (!resp.ok) {
    console.error(`API error ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  
  return resp.json();
}

// --- Commands ---
const [,, cmd, ...args] = process.argv;

const commands = {
  // Each discovered endpoint becomes a command
  // Example:
  // async list() { ... }
  // async get(id) { ... }
  // async create(json) { ... }
};

if (!cmd || !commands[cmd]) {
  console.log('Usage: {app-name} <command> [args]');
  console.log('Commands:', Object.keys(commands).join(', '));
  process.exit(0);
}

const result = await commands[cmd](...args);
console.log(JSON.stringify(result, null, 2));
```

### Validation

Before calling the skill done, validate that:

1. **Auth works** — run a simple read-only API call
2. **Each endpoint works** — dry-run every discovered endpoint
3. **Error handling works** — confirm 401 triggers re-auth prompt, 429 shows rate limit message
4. **The .jsh is callable** — run it as a shell command and verify output
5. **The SKILL.md is accurate** — endpoints match what the scripts actually do

## Decision tree

```
User wants to automate {app}
│
├─ Is there a known public API?
│  ├─ Yes → dry-run with browser session
│  │  ├─ Works → skip to Phase 4 (compile skill)
│  │  └─ Fails → investigate auth (Phase 2), then retry
│  │
│  └─ Not sure → check if model knows the API
│     ├─ Confident guess → dry-run to validate
│     └─ No idea → HAR capture (Phase 1)
│
├─ HAR capture reveals API?
│  ├─ Clean REST/GraphQL → extract patterns, compile skill
│  └─ Messy/encrypted/signed → try matching browser headers exactly
│     ├─ Works → compile skill
│     └─ Fails → fall back to DOM observation
│
└─ Does the user need to watch for changes?
   ├─ Yes → set up webhook + observer (.bsh)
   │  ├─ API supports webhooks/SSE → use native push
   │  ├─ Network observable → PerformanceObserver
   │  ├─ DOM observable → MutationObserver
   │  └─ Nothing observable → cron-based polling
   └─ No → skip Phase 3
```

## Tips

- Start cheap. A known API with a dry-run is minutes of work. HAR capture and analysis is an order of magnitude more effort. DOM scraping is the most fragile. Always try the cheaper option first.
- When writing HAR filter expressions, err on the side of keeping too much rather than filtering too aggressively. You can always ignore irrelevant entries during analysis, but you can't recover filtered-out traffic.
- The user's browser session is the golden ticket. Most bot detection, rate limiting, and auth challenges have already been solved by the fact that the user logged in normally. Ride that session.
- For GraphQL apps, look for a single `/graphql` endpoint. The value is in the query/mutation schemas, not the URL patterns. Capture several different operations to map the schema.
- When the generated skill uses `fetch()`, remember that SLICC's fetch is proxied through the CLI server. It handles CORS, but cookie-based auth requires explicitly passing cookies extracted from the browser.
- Name the generated skill after the app, not the task. `slack` not `slack-message-sender`. The skill should cover the full API surface you discovered, not just one use case.
