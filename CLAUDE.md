# CLAUDE.md — ai-ecoverse/skills

Agent skills for the [SLICC](https://github.com/ai-ecoverse/slicc) runtime. Each skill lives in `skills/<name>/` with a required `SKILL.md` and optional `scripts/*.jsh`, `references/`, `assets/`. `SKILL.md` frontmatter: `name`, `description`, `allowed-tools: bash`, optionally `command:` + `script:` to wire the shell command explicitly. The `description` doubles as the activation prompt — make it long and trigger-phrase-rich.

The rest of this file is about writing `.jsh` scripts well. It is distilled from the slicc runtime source (ground truth), all 31 `.jsh` files in this repo, and 175 PRs of review history. Precedence when sources disagree: slicc source code > this file > header comments in old scripts > slicc's `docs/*.md` (several are drifted — `shell-reference.md`'s QuickJS claim is wrong, and `node-compat-shims.md` overstates the `process`/`crypto`/`assert`/`util` shims). **When in doubt about the runtime surface, probe it** (`typeof process.argv.parseFlags`) — half the fleet's header comments fossilized a mid-migration state and are wrong.

## 1. Execution model

- A `.jsh` file is **JavaScript, not bash**. It runs in a DedicatedWorker (V8), compiled as the body of an `AsyncFunction` — so **top-level `await` and top-level `return` are both legal**.
- Command discovery: any `*.jsh` anywhere under the skill dir becomes a shell command named after its basename (`scripts/foo.jsh` → `foo`). The `scripts/` subdir is convention, not required. First-found basename wins; `/workspace/skills` is scanned first; precedence at dispatch is built-in > `.jsh` > saved workflow.
- `process.argv` is `['node', <scriptPath>, ...args]`.
- stdout/stderr are **buffered and delivered when the run completes** — don't design around streaming progress output.
- No wall-clock timeout. Scripts are killable by signal: SIGINT→130, SIGKILL→137, SIGTERM→143.
- Exit codes: clean completion → 0; `process.exit(N)` / `cli.die` → N; **any uncaught throw → 1** with the stack on stderr; missing script → 127.
- `process.exit()` and `cli.die()` don't halt synchronously — they **throw `NodeExitError`** to unwind. See §6 for the mandatory re-throw rule.

## 2. Globals and require()

Available globals: `process` (`argv` + non-enumerable `argv.parseFlags()`, `env`, `cwd()`, `exit()`, one-shot buffered `stdin`, `stdout`/`stderr` with `isTTY`), `console` (**only** `log`/`info` → stdout, `warn`/`error` → stderr; objects are `JSON.stringify`'d, not inspected), `fetch` (bridged through the kernel — CORS bypass and server-side secret unmasking; not the page's fetch), `Buffer` (polyfill), `__dirname`/`__filename`, and the worker's web globals (`URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `Blob`, `FormData`, `Headers`/`Request`/`Response`, `atob`/`btoa`, Web Crypto, `AbortController`, `setTimeout`/`setInterval`/`queueMicrotask`).

NOT present: `process.platform`/`.arch`/`.version`/`.pid`/`.on`/`.nextTick`, `console.debug`/`.table`/`.dir`, bare `fs`/`path`/`exec` globals (all bare capability globals were hard-cut to `require('sliccy:*')`, issue #168).

`require()` resolves, in order: `sliccy:*` → served node builtins → everything else.

- Served builtins: `fs`, `fs/promises`, `path`, `crypto`, `child_process`, `process`, `buffer`, `assert`, `util`, `events`, `os`, `stream`, `url`, `zlib`. `fs` is the VFS bridge: `readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile` — methods live directly on the object (not only under `.promises`); no `watch`, no streams. Sync reads cap at 1 MB (`ENOSYNC`) — use async `readFile` for large files.
- `http`/`https`/`net`/`tls`/`dns`/`vm`/`worker_threads` throw — use `fetch()`.
- npm packages resolve only from ipk-installed VFS `node_modules` (`ipk install x`) — **no CDN fallback**. Native packages (`sharp`, `sqlite3`, `puppeteer`, `canvas`, …) hard-throw. `require('playwright')` returns a CDP-backed shim.
- Shim gaps vs real Node: `crypto.createHash` supports only md5/sha1/sha256; `util` has only `format`/`formatWithOptions`/`inspect`/`inherits`/`promisify`; `assert` lacks `rejects`/`match`.

## 3. sliccy: module quick reference

```js
const exec = require('sliccy:exec');
exec(cmd)                    // → {stdout, stderr, exitCode} — runs a REAL shell (injection risk, §7)
exec.spawn(argv[])           // no shell parsing — use for anything containing a variable
exec.start(cmd|argv, {stdin, stdinKind, args})  // → {kill(sig), stdin:{write,end}, done}

const agent = require('sliccy:agent');
agent(prompt, {model, thinking, schema, cwd, allowedCommands, readOnly})  // throws on non-zero exit / schema failure
agent.spawn(prompt, opts)    // → {finalText, exitCode, stderr}, never throws

const skill = require('sliccy:skill');
skill.dir; skill.refs; skill.assets          // script-relative paths — never hardcode /workspace/skills/...
await skill.config()                          // null if absent — Promise is truthy, so ALWAYS (await skill.config()) || {}
await skill.config({key: val})                // shallow-merge + persist
await skill.token(providerId)                 // OAuth broker

const http = require('sliccy:http');
const api = http.client({baseUrl, token, headers, retry: {on: [429, 503], maxAttempts: 3}, timeoutMs});
await api.get(path, {params, headers})        // .post/.put/.patch/.delete; body objects auto-JSON'd
await api.get(path, {raw: true})              // → {body, headers, status} instead of parsed body
// throws HttpError{status, statusText, url, body} on non-2xx; honors Retry-After; normalizes a
// missing leading slash (hand-rolled BASE+path concat produced "api.github.comuser", PR #127);
// retry shape is {on, maxAttempts} — {attempts, backoff} is silently ignored;
// repeated query params: pass an array in params — never comma-join (Gmail metadataHeaders bug)

const browser = require('sliccy:browser');
await browser.findTab({urlMatch: /strava\.com/})   // → tab | null; prefer urlMatch over {domain} —
                                                    // domain:'icloud.com' missed www.icloud.com; escape dots
await browser.ensureTab(url, {matchUrl})
await browser.eval(tab, fnOrString)                 // pass a real Function when possible — auto-serialized to an IIFE
await browser.evalAsync(tab, fnOrString)            // async, transparent double-JSON unwrap host-side
await browser.cookie(tab, name); await browser.localStorage(tab, key)
await browser.fetch(tab, url, {method, headers, body, responseType})  // runs INSIDE the tab's origin —
                                                    // session cookies automatic; → {ok, status, headers, body, bodyEncoding?}
browser.websocket.on(tab, {urlMatch}).filter({parseAs, where, project}).forward({sink})
                                                    // sinks: webhook|scoop|vfs|log; filters are declarative JSON only

const cli = require('sliccy:cli');
cli.die(msg, {exitCode, prefix})   // "Error: msg" red to stderr, exits (default 1); prefix:'' suppresses the label
cli.out(value)                     // string → stdout; else pretty JSON — the --json output primitive
cli.warn(msg); cli.help(text)      // help → stdout, exit 0

const color = require('sliccy:color');   // .green .red .yellow .gray .bold .cyan .dim
                                          // identity functions when !TTY or NO_COLOR — never gate logic on color
const time = require('sliccy:time');      // parseDuration/ago/range/future — 'm' = MINUTES, 'M' = months
const fmt = require('sliccy:fmt');        // trunc/col/table (ANSI-aware), date(v, 'short'|'iso'|'human'|'locale')
const pool = require('sliccy:pool');      // pool(concurrency, items, fn) — bounded fan-out, results in order
```

## 4. Canonical script skeleton

Best exemplars in-repo: `skills/strava/scripts/strava.jsh`, `skills/swarm/scripts/swarm.jsh`, `skills/garmin/scripts/garmin.jsh` (richest formatters + token lifecycle), `skills/da-live/da-live.jsh` (smallest complete one).

```js
// mytool.jsh — one-line description (uses browser session)
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const HELP = `
mytool — what it does

USAGE
  mytool list [--limit N]      ...
  mytool get <id>              ...

FLAGS
  --json       Output raw JSON

REQUIRES
  example.com open and logged in in your browser
`.trim();

// ── args ──────────────────────────────────────────────────────────────
const parsed = process.argv.parseFlags();       // {positional, flags, subcommand, passthrough}
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);  // drop the leading subcommand
const flags = parsed.flags;                     // booleans are real `true`; repeated flags become arrays

// ── session ───────────────────────────────────────────────────────────
let _tab = null;                                // memoize — SSO redirects move tabs off-domain mid-flow
async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /example\.com/ });
  if (!_tab) cli.die('open example.com in your browser first', { prefix: 'mytool' });
  return _tab;
}

async function apiFetch(tab, path, opts = {}) { // ONE wrapper — uniform auth-expiry guidance for every command
  const res = await browser.fetch(tab, `https://example.com${path}`, {
    ...opts,
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*', ...(opts.headers || {}) },
  });
  if (res.status === 401 || res.status === 403)
    cli.die('session expired — log in to example.com in your browser, then retry', { prefix: 'mytool' });
  if (!res.ok) cli.die(`example returned ${res.status} for ${path}`, { prefix: 'mytool' });
  return res.body;
}

// ── commands ──────────────────────────────────────────────────────────
async function cmdList(tab, flags) {
  const parsedLimit = parseInt(flags.limit ?? flags.l, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 10;
  const data = await apiFetch(tab, `/api/items?limit=${limit}`);
  if (flags.json) { cli.out(data); return; }
  const items = Array.isArray(data) ? data : (data.items || data.results || []);
  if (!items.length) { console.log(color.dim('  No items found.')); return; }
  for (const it of items) console.log(`  ${color.cyan(color.bold(it.name))}  ${color.dim(`id:${it.id}`)}`);
}

async function cmdGet(tab, positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: mytool get <id>', { prefix: 'mytool' });
  const data = await apiFetch(tab, `/api/items/${encodeURIComponent(id)}`);
  if (flags.json) { cli.out(data); return; }
  const item = data.item || data;                 // shape-shifting APIs — §9
  console.log(`  ${color.cyan(color.bold(item.name || 'Item'))}  ${color.dim(`id:${item.id ?? id}`)}`);
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') { cli.help(HELP); }
  const tab = await getTab();
  try {
    if (subcommand === 'list') await cmdList(tab, flags);
    else if (subcommand === 'get') await cmdGet(tab, positional, flags);
    else cli.die(`unknown command: ${subcommand}\nRun 'mytool --help' for usage.`, { prefix: 'mytool' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;   // MANDATORY — see §6
    cli.die(err.message, { prefix: 'mytool' });
  }
}
await main();
```

On `parseFlags`: **`process.argv.parseFlags()` is real and current** (a non-enumerable helper on `argv`). It briefly disappeared during the bare-globals→`sliccy:` migration, which is why `gh.jsh`/`strava.jsh` carry local reimplementations and comments calling it "genuinely gone" while `icloud.jsh` calls it "a real bare global" — the latter is correct today. New scripts use the runtime helper. Don't propagate the local copies or the fossil comments.

## 5. Auth patterns, in order of preference

1. **Browser session, token never leaves the page** — the house style (strava, jira, slack, suno, navan, teams, linkedin, …). `browser.fetch` in the tab origin carries cookies automatically; when a bearer token must be read from `window`/`localStorage`, mint and use it **inside** `evalAsync` rather than returning it to the realm.
2. `skill.token(provider)` OAuth broker (aem, gh) — pair with an **upfront** `cli.die` listing every credential fallback when none resolves; an empty token surfacing later as an opaque 401 was a P1 (gh.jsh).
3. `skill.config()` persisted tokens with refresh + expiry skew (garmin).
4. Env vars (gmail's `GWS_*`).
5. Config files on disk — least preferred; if displaying a token, truncate it.

External-CLI-plus-manual-secret-wiring skills lost historically (#52 abandoned); reuse-the-browser-session won.

## 6. Error handling

- `cli.die(msg, {prefix: '<tool>'})` with an **actionable** message: say what the user should do ("log in to X and retry"), not what the code couldn't do.
- **The NodeExitError rule** (most-repeated bug in repo history): `cli.die`/`process.exit` throw `NodeExitError` to unwind. **Every `catch` that wraps command dispatch or an operation containing a `die` must re-throw it first**: `if (err?.name === 'NodeExitError') throw err;` Otherwise you reprint a confusing second error (garmin), downgrade a real auth failure to a warning (gmail), or neutralize a security guard entirely (slack's duplicate-watch check silently swallowed → leaked webhooks).
- `await` before falsy fallbacks: `skill.config() || {}` never falls back — a Promise is always truthy. `(await skill.config()) || {}` (confirmed-live garmin bug).
- Validate required args at the top of each command with a usage line. Check auth errors **before** exit codes when shelling out — `curl` returns 0 on HTTP 401 (aem.jsh).
- Exit non-zero on failure **even in `--json` mode** (#76).

## 7. Security (every rule here has a P1 behind it)

1. **`exec()` runs a real shell** — proven live: a value of `x; echo INJECTED` executed the injected command. Prefer `exec.spawn([bin, ...args])` for anything containing a variable. If you must build a shell string, validate each interpolated value against a strict allowlist (`/^[A-Za-z0-9._-]+$/` for names, `/^[A-Za-z0-9._/-]+$/` for paths) or single-quote it with `'\''` escaping (see `shellQuote` in aem.jsh, validators in slack.jsh).
2. Embed values into page-eval JS via `JSON.stringify(value)`, never string concatenation. Validate IDs structurally first (`urn:li:activity:<digits>`, linkedin.jsh).
3. **Never post-process `JSON.stringify` output with regex escaping** — single-quote escaping is a no-op and backslash-doubling corrupts `\"`. When hand-escaping is unavoidable, escape backslashes first. Escape XML metacharacters in constructed XML (`&` broke concur).
4. **No hardcoded IDs, no silent fallback to a default identity.** Resolve the current user/athlete/mailbox dynamically and `die` loudly on failure — the single most repeated P1 (gh, linkedin, strava, slack all shipped the author's own IDs as fallbacks).
5. Nothing secret to stdout — everything a `.jsh` prints lands in the agent transcript (#203).
6. Gate spending/destructive operations behind `--confirm` with a preview (navan is the reference; also `--dry-run`, jira). Paginate fully before any destructive operation on the list (#21). Bound fan-out with `pool()` — `Promise.all` over 100+ calls hits rate limits (#53).
7. Quote (don't rewrite) remote-controlled strings echoed into suggested commands — branch names are attacker-controlled (#48), but sanitizing broke legitimate `feature@2` (#49).

## 8. The bridge rules (the jsh-specific bug class)

1. **Serialize exactly once across `evalAsync`.** Return raw values from the page; the host does a transparent double-JSON unwrap. Page-side `JSON.stringify` + realm-side `String()` produced `''` and `'[object Object]'` (speck). Defensive guard on receipt: `typeof raw === 'string' ? JSON.parse(raw) : raw` (suno).
2. String-form eval must be an **invoked IIFE** — `"(async () => {...})()"` — a bare function expression makes `evalAsync` silently return `{}` (apple-music). Passing a real `Function` avoids this: the bridge serializes it to a call expression for you.
3. `browser.fetch` reads the response body exactly once. When an endpoint serves HTML, request `Accept: text/html` explicitly — a JSON Accept hint against an HTML response can trip a body-already-read error in the bridge (strava). If the bridge misbehaves on empty-bodied PATCH/DELETE responses, do the fetch manually inside `evalAsync` and read the body once (apple-music).
4. The current bridge JSON-encodes plain-object bodies with `Content-Type: application/json`; older bridge versions didn't (P1s on #193). `JSON.stringify` explicitly anyway — explicit survives runtime churn.
5. **Page-context code resolves paths against the page origin** — a `fetch('/tmp/x.png')` inside the page hits `https://host/tmp/x.png`, not your filesystem (#79). File bytes cross the bridge via `fs.writeFileBinary` on the realm side. Binary responses arrive base64 with `bodyEncoding: 'base64'`; force with `responseType: 'binary'`.
6. Encoding traps: `btoa` is Latin-1-only (CJK/emoji throw — chunk through `TextEncoder`); base64url needs `-_`→`+/` and padding restored before `atob`; shell argv caps at ~1 MB, so pipe large payloads through stdin in base64 chunks (concur.jsh `writeFile`).
7. Handle expected non-JSON: a login wall returns HTML where JSON was expected — detect `<html`/`<!DOCTYPE` in the text and translate to "session may have expired" (linkedin) instead of a JSON.parse stack.
8. Meta-traps: help text containing the word `await` once tripped the top-level-await transpile detector (f1cbc32); scan for both mojibake byte families (C3A2/C382 and EF BF BD) after editing.

## 9. Defensive patterns for shape-shifting APIs

- Fallback chains at every boundary: `data.currentAthlete || data`, `Array.isArray(data) ? data : (data.items || data.results || [])`, `data.count ?? data.num ?? data`.
- When a detail endpoint nests what a list endpoint flattens, normalize once at the fetch site (`{...data, ...(data.summaryDTO || {})}`, garmin) so downstream code handles one shape.
- Clamp numeric flags: `const n = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : DEFAULT;`
- `try { JSON.parse } catch` around every text boundary; `stripHtml` before rendering strings from web APIs.
- Comment wire-format discoveries with the **date and issue number** you verified them (`captured live 2026-07-10, issue #208`) — these comments are the only durable record of undocumented APIs.

## 10. Output conventions

- Every command supports `--json` → `cli.out(data)` with the **raw** response, early-return. Human mode otherwise.
- Human output: two-space indent, leading blank line per section, `color.dim('  ' + '─'.repeat(52))` separators, dimmed empty-state messages (`'  No activities found.'`), `color.cyan(color.bold(name))` for titles, `color.dim('id:…')` so the agent can chain commands, `color.green('✓')` for success.
- Emoji as data icons is fine (strava's activity map); keep IDs in output — downstream agent calls need them.

## 11. Approach selection — lessons from abandoned and rewritten PRs

- **Live verification against a real authenticated session is the merge bar.** #187 passed a synthetic harness while a P1 broke every authenticated command; its successor #200 merged on "12/16 subcommands exercised with real data, zero bugs". State what you verified live in the PR body.
- **Prove no cleaner data source exists before DOM-scraping — then scrape without guilt.** The teams saga's wire test (HAR + WebSocket capture showing zero caption traffic → captions are WebRTC/DOM-only) is the template (af9efcd).
- **MutationObserver per semantic element beats polling**, and you must learn the DOM's actual lifecycle first (each caption element grows, then finalizes; iterate the real spans, not `list.children`) — five approach revisions in #215/#216 to get there.
- **When a rich-text editor ignores DOM edits, drive real CDP input from the accessibility snapshot** — Teams' CKEditor drops execCommand/paste as orphan nodes, and the eval context may be detached mid-meeting.
- **When an API rejects your well-formed request, HAR-capture the working web client and diff payloads** — LinkedIn's message-send needed `Content-Type: text/plain;charset=UTF-8` and a 16-raw-byte `trackingId`, discoverable no other way (#208).
- **Direct generation beats framework + data contract for LLM-authored artifacts**: the reveal.js + JSON-contract presentations skill (3,730 lines) lost to "the agent writes complete HTML/CSS directly" (363 lines) because the contract drifted from the renderer (#65→#74). Generic npm utility deps lost to purpose-built `sliccy:` APIs the same way (#27).
- **Keep feature logic decoupled from the I/O layer** — concur's new commands survived a platform migration by transplant because they only touched `callOp()` internals (#145→#158).
- **Injected page state must be re-armable and rollback-safe**: idempotent guard (`if (window.__slicc_observer) return;`), clean up webhook + state file when injection fails, and on restart delete the prior webhook **only after** the replacement is installed — an orphaned webhook leaked captions across meetings (#216). Flush cursors must survive buffer resets (#215).
- Every advertised flag must change behavior, and help text / `SKILL.md` / code stay in lockstep — flag-parses-but-does-nothing and doc drift are reliably flagged as P1/P2 (#66, #122).
- Derive paths from `skill.dir` — never hardcode `/workspace/skills/<name>/` (three P1s). Use `/shared` (not `/tmp`) for files another process or container must read (#53).

## 12. Process

- No direct pushes to main — every skill change goes through a PR (#56/#57).
- Fork PRs can't reach secret-gated CI; maintainers re-push the branch in-repo rather than using `pull_request_target` (#119→#125, #149).
- When parallel agents produce duplicate PRs, the first-opened, independently verified one wins — even over a more complete later duplicate (#191 vs #199).
- Before "fixing" an assumption about the runtime, read the slicc source — the `scripts/`-dir "fix" was a no-op because discovery is recursive (#81).

## 13. .bsh observers (page-injected, not realm)

`.bsh` files are JavaScript **injected into the target page via CDP on navigation** — no realm, no `sliccy:` bridges, no `require` (bundle first: `ipk add <pkg>` then `ipx esbuild --bundle`). Filename maps to hostname: `-.okta.com.bsh` = `*.okta.com` wildcard, `login.okta.com.bsh` = exact; `// @match <glob>` directives (first 10 lines) restrict further. Scanned under `/workspace` and `/shared`. Rules from `skills/secret-sauce/references/observers.md`: pick the cheapest observer (webhook/SSE > PerformanceObserver > MutationObserver > polling), guard injection idempotently, post via `fetch().catch(() => {})` — an observer must never throw. Shell work belongs in a `.jsh`, not a `.bsh`.
