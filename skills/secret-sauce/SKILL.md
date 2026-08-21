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

**Rule of thumb:** If the API is designed for third-party integrations (documented, uses API keys/PATs), use `fetch()` directly. If the API is the web app's own backend, call it from the page context — it carries real cookies, correct origin, and full browser state. During discovery that means `playwright-cli eval`; in the *generated* script it means `require('sliccy:browser').fetch(tab, …)`.

`require('sliccy:exec')` returns `{stdout, stderr, exitCode}`. Use it for `webhook` and other shell commands from .jsh scripts. It runs a **real shell** — pass `exec.spawn([bin, ...args])` for anything containing a variable.

## Modules: never hand-roll what `require()` already gives you

Generated `.jsh` scripts are JavaScript with a CommonJS `require()`. Reach for a module before writing a helper — the recurring review failure in generated skills is 200 lines of hand-rolled arg parsing, shell quoting, table formatting, and duration math that the runtime already ships.

`require()` resolves in this order: `sliccy:*` capability bridges → served Node built-ins → `node_modules` on disk.

**1. `sliccy:*` — always available, zero install. Prefer these over any npm equivalent.**

| Need | Use | Not |
| --- | --- | --- |
| Argument parsing | `process.argv.parseFlags()` → `{positional, flags, subcommand, passthrough}` | `minimist`, a hand-rolled loop |
| Shell quoting | `exec.spawn([bin, ...args])` from `sliccy:exec` | `shell-quote`, a hand-rolled `shellQuote()` |
| Errors / usage / `--json` output | `sliccy:cli` — `cli.die`, `cli.out`, `cli.warn`, `cli.help` | `process.exit` + `console.error` |
| Terminal color | `sliccy:color` — no-ops when `!isTTY` or `NO_COLOR` | `chalk`, `picocolors` |
| Tables, truncation, dates | `sliccy:fmt` — `table`, `col`, `trunc`, `date` (ANSI-aware) | `cli-table3`, `date-fns` |
| Durations, `--since`/`--until` | `sliccy:time` — `parseDuration`, `ago`, `range`, `future` (`m` = minutes, `M` = months) | `ms`, `dayjs` |
| Bounded fan-out | `pool(concurrency, items, fn)` from `sliccy:pool` | `Promise.all` over the whole list, `p-limit` |
| Retrying HTTP client | `sliccy:http` — `http.client({baseUrl, token, retry: {on, maxAttempts}})` | `axios`, `got`, a hand-rolled retry |
| Page-context fetch, cookies, tabs | `sliccy:browser` | `exec('playwright-cli …')` |
| Skill paths, config, OAuth tokens | `sliccy:skill` — `skill.dir`, `skill.refs`, `(await skill.config()) \|\| {}`, `skill.token(id)` | hardcoded `/workspace/skills/<name>/` |

The full set: `exec`, `agent`, `skill`, `http`, `browser`, `cli`, `color`, `time`, `fmt`, `pool`, `usb`, `serial`, `hid`. An unknown name throws and lists the known ones.

**2. Node built-ins** — `require('fs')`, `fs/promises`, `path`, `crypto`, `child_process`, `buffer`, `assert`, `util`, `events`, `os`, `stream`, `url`, `zlib`. `fs` is the VFS bridge (`readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile`) — no `watch`, no streams, sync reads capped at 1 MB. `http`/`https`/`net`/`tls`/`dns`/`vm`/`worker_threads` throw; use `fetch()` or `sliccy:browser`.

**3. npm packages — only if installed, and there is no CDN fallback.** A bare `require('some-pkg')` resolves by walking `node_modules` upward from the *script's own directory*. Nothing is bundled and nothing is fetched from a CDN: an uninstalled package fails immediately with `Cannot find module 'x' (run: ipk install x)`.

```bash
cd /workspace/skills/{app-name}/scripts
ipk install some-pkg           # writes node_modules/ + package.json
ipk add esbuild-wasm           # only if the package is ESM and needs transpiling
```

`node_modules/` is gitignored, so an installed tree does **not** travel with the skill. A generated skill that needs a package must therefore pick one of:

- **Drop the dependency** — the default. Check the `sliccy:` table above first; it covers almost every reason a generated client reaches for npm.
- **Bundle it** — `esbuild <src>.js --bundle --format=cjs --target=node18 --outfile=<name>.jsh` and commit the single generated file (the `xlsx` skill is the reference).
- **Document a one-time install** — put the exact `ipk install` line in the generated `SKILL.md` and make the script fail with an actionable error naming that command (the `v86` skill is the reference).

Native packages (`sharp`, `sqlite3`, `puppeteer`, `canvas`, …) hard-throw — they can never work here. Prefer a `sliccy:` bridge over any dependency: a purpose-built bridge has beaten a generic npm utility every time it came up in review.

**Limitation — static specifiers only.** The module graph is built by scanning the entry file for `require('<string-literal>')` before it runs. `require(pkgName)` with a variable, or a specifier assembled at runtime, is not in the graph and throws. Write every specifier as a literal at the top of the script.

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
│   ├── watch.jsh                    # Observer/webhook setup (if applicable)
│   └── package.json                 # ONLY if an npm dependency was unavoidable
│                                    # (node_modules/ is gitignored — see Modules)
├── references/
│   ├── endpoints.md                 # Discovered API endpoints
│   ├── auth-strategies.md           # Auth strategy table
│   ├── har-filter.md                # Full annotated HAR capture filter
│   ├── observers.md                 # Observer type selection and patterns
│   └── page-context-helper.md       # openApp()/apiViaBrowser() — discovery-time
│                                    # playwright-cli helpers; the shipped .jsh
│                                    # uses sliccy:browser instead
└── assets/
    ├── observer.js                  # Page-context observer (if applicable)
    └── -.{domain}.bsh               # Auto-injector (if applicable)
```

### .jsh script structure

The filename without `.jsh` becomes the shell command name. Start from this template — it is the house style, and every utility it needs comes from `require()` rather than a local helper (see [Modules](#modules-never-hand-roll-what-require-already-gives-you)).

```js
// {app-name}.jsh — API client for {App Name} (uses the browser session)
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const HELP = `
{app-name} — talk to {App Name} via its API

USAGE
  {app-name} list [--limit N]
  {app-name} get <id>

FLAGS
  --json       Output raw JSON

REQUIRES
  {app-domain} open and logged in in your browser
`.trim();

// ── args ── runtime parser; do not hand-roll and do not install minimist
const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);   // drop the leading subcommand
const flags = parsed.flags;                      // booleans are real `true`; repeats become arrays

// ── session ── memoize: SSO redirects move the tab off-domain mid-flow
let _tab = null;
async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /{app-domain-escaped}/ });   // urlMatch beats {domain}; escape the dots
  if (!_tab) cli.die('open {app-domain} in your browser first', { prefix: '{app-name}' });
  return _tab;
}

// ── one fetch wrapper ── so every command gives identical auth-expiry guidance
async function apiFetch(tab, path, opts = {}) {
  const res = await browser.fetch(tab, `https://{app-domain}${path}`, {
    ...opts,
    headers: { 'Accept': 'application/json', ...(opts.headers || {}) },   // + any CSRF/custom header the HAR showed
  });
  if (res.status === 401 || res.status === 403)
    cli.die('session expired — log in to {App Name} in your browser, then retry', { prefix: '{app-name}' });
  if (!res.ok) cli.die(`{App Name} returned ${res.status} for ${path}`, { prefix: '{app-name}' });
  return res.body;
}

// ── commands ──
async function cmdList(tab, flags) {
  const n = parseInt(flags.limit ?? flags.l, 10);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 10;
  const data = await apiFetch(tab, `/api/items?limit=${limit}`);
  if (flags.json) { cli.out(data); return; }
  const items = Array.isArray(data) ? data : (data.items || data.results || []);
  if (!items.length) { console.log(color.dim('  No items found.')); return; }
  for (const it of items)
    console.log(`  ${color.cyan(color.bold(it.name))}  ${color.dim(`id:${it.id}`)}  ${fmt.date(it.updated, 'human')}`);
}

async function cmdGet(tab, positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: {app-name} get <id>', { prefix: '{app-name}' });
  const data = await apiFetch(tab, `/api/items/${encodeURIComponent(id)}`);
  if (flags.json) { cli.out(data); return; }
  const item = data.item || data;                      // detail endpoints nest what list endpoints flatten
  console.log(`  ${color.cyan(color.bold(item.name || 'Item'))}  ${color.dim(`id:${item.id ?? id}`)}`);
}

// ── main ──
async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  const tab = await getTab();
  try {
    if (subcommand === 'list') await cmdList(tab, flags);
    else if (subcommand === 'get') await cmdGet(tab, positional, flags);
    else cli.die(`unknown command: ${subcommand}\nRun '{app-name} --help' for usage.`, { prefix: '{app-name}' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;   // MANDATORY: cli.die/process.exit unwind by throwing this
    cli.die(err.message, { prefix: '{app-name}' });
  }
}
await main();
```

Notes that survive review:
- Top-level `await` and top-level `return` are both legal — the file runs as an async function body.
- `cli.die`/`process.exit` throw `NodeExitError` to unwind. **Every** catch around command dispatch must re-throw it first, or a real auth failure is downgraded into a confusing second error.
- Every command takes `--json` and early-returns the raw response via `cli.out`. Still exit non-zero on failure in `--json` mode.
- Resolve the current user/account dynamically and `die` loudly if that fails. Never ship a hardcoded ID as a fallback identity.
- For a token-based API, swap `browser.fetch` for `http.client({baseUrl, token, retry: {on: [429, 503], maxAttempts: 3}})` from `sliccy:http` — it honours `Retry-After` and throws `HttpError{status, url, body}`, so no hand-rolled retry loop is needed.

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
6. No hand-rolled helper duplicates a module — grep the script for a local arg parser, `shellQuote`, colour escapes, a retry loop, or a table formatter and replace each with its `require()` equivalent
7. Every `require()` specifier is a string literal, and every bare npm package actually resolves (run the script once; an uninstalled one fails with `Cannot find module … (run: ipk install …)`)

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
