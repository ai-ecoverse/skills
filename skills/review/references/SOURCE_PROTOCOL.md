# Review source protocol

The contract every skill must satisfy to contribute to the review backlog.
A command is **review-compatible** when it exposes a `review` sub-command that
accepts the standard flags and writes **one JSON object** to stdout.

This is the same shape as the monday source protocol, pointed at a persistent
queue rather than a one-shot inbox: monday aggregates; review records.

## Invocation contract

`review ingest` calls each source exactly as:

```bash
[cmd] review --path PATH [--id ID]
```

| Flag | Meaning | Passed from |
|------|---------|-------------|
| `--path PATH` | File or URL the source should analyse | `review ingest --path` (required) |
| `--id ID` | Review-card id to attach findings to | `review ingest --id` (optional; source may derive one) |

The source **must**:

- Write a **JSON object** (`{...}`) to **stdout** — nothing else on stdout.
- Send all progress, logging, and errors to **stderr**.
- Exit `0` on success. Sources that exit non-zero, print empty stdout, or emit
  non-object / invalid JSON are logged as a `WARNING` and dropped; ingest
  continues with the remaining sources.
- Be **optional**. A missing command (`which` fails) is skipped, not an error.
  Review works with zero integrations installed.

Do not write to the sprinkle from a source. Sources emit JSON; only `review ingest`
(or the cone) sends `ensure-item` / `add-findings`.

## Contribution schema

One object per invocation. `source` is required; everything else is used if present.

| Field | Required | Type | Used by `review ingest` for |
|-------|----------|------|-----------------------------|
| `source` | **yes** | string | Findings bucket on the card (`pangram`, `check-llm-cliches`, …). Contributions without `source` are dropped. |
| `id` | recommended | string | Card id. Must be stable. Prefer the `--id` you were passed; otherwise derive a source-prefixed id. Ingest uses `--id` if given, else this field, else a path-based fallback. |
| `title` | no | string | Card title for `ensure-item` when the card is new. |
| `path` | no | string | File path shown on the card. |
| `previewUrl` | no | string | Preview link. |
| `liveUrl` | no | string | Live link. |
| `summary` | no | string | One-line result shown on the card (`Mixed · 60% AI-assisted`). |
| `severity` | no | `info` \| `warn` \| `fail` | Badge colour. Default `info`. |
| `findings` | no | array | Detail rows. Each item: `{ title, body?, severity?, line?, start?, end? }`. |
| `meta` | no | object | Passthrough (scores, window counts, pattern ids). Not rendered unless a finding cites it. |
| `ts` | no | string (ISO-8601) | When the check ran. |

### Minimal contribution

```json
{ "source": "pangram", "summary": "Human", "severity": "info", "findings": [] }
```

### Typical contribution

```json
{
  "source": "check-llm-cliches",
  "id": "page-1",
  "title": "Security page",
  "path": "/shared/security.md",
  "summary": "4 matches across 3 patterns",
  "severity": "warn",
  "findings": [
    { "severity": "warn", "title": "no-chain", "body": "No fluff, no filler", "line": 12 }
  ],
  "meta": { "matches": 4 }
}
```

Empty `findings` with a `summary` is a successful clean check, not a skip.

## Sprinkle messages (UI)

`review ingest` translates each contribution into two inbound sprinkle messages
(see `templates/review.shtml`):

1. `ensure-item` — upsert the card (`id`, `title`, `path`, `previewUrl`, `liveUrl`). Status is never touched.
2. `add-findings` — `{ id, source, summary, severity, findings, ts }` stored at `state.findings[id][source]`. Re-running a source replaces that source's block; other sources on the same card stay.

The panel also accepts `clear-findings` `{ id, source? }`. Omit `source` to drop every integration on that card.

Sources must not send these themselves.

## How `review ingest` consumes the contract

1. **Discover sources.** With no positional args, run `which [cmd]` for each name in `KNOWN_INTEGRATIONS` (`pangram`, `check-llm-cliches`) and keep those found on PATH. Otherwise use the names supplied as positional args.
2. **Invoke in parallel.** `[cmd] review --path PATH [--id ID]` for every discovered source.
3. **Validate JSON.** Non-zero exit, empty stdout, or a non-object is a stderr `WARNING`; ingest continues.
4. **Upsert the card** via `ensure-item` (once).
5. **Attach findings** via `add-findings`, one message per source, in argument order.

`--dry-run` prints the contributions as a JSON array and does not touch the sprinkle.

## Reference handler

```javascript
async function reviewContribution(args) {
  const f = args.parseFlags();
  const filePath = f.path;
  if (!filePath) {
    console.error('usage: mysource review --path PATH [--id ID]');
    process.exit(2);
  }
  const report = await analyse(filePath); // your work
  const contribution = {
    source: 'mysource',
    id: f.id || ('mysource:' + filePath),
    path: filePath,
    title: filePath.split('/').pop(),
    summary: report.summary,
    severity: report.severity,
    findings: report.findings,
    ts: new Date().toISOString()
  };
  console.error('[mysource] review: ' + report.findings.length + ' findings');
  console.log(JSON.stringify(contribution));
}
```

## Registering a new source

- **One-off:** name it — `review ingest mysource --path FILE`.
- **Auto-discovery:** add the command name to `KNOWN_INTEGRATIONS` in `scripts/review.jsh`.

The `review` command itself is excluded from `KNOWN_INTEGRATIONS` so it never recurses.

## First-party sources (optional)

| Command | Skill | What it adds |
|---------|-------|----------------|
| `pangram` | `ai-writing-detector` | Pangram AI-text classification (needs `PANGRAM_API_KEY` or `pangram` skill config) |
| `check-llm-cliches` | `ai-writing-detector` | Simon Willison's LLM cliché highlighter (local, no key) |

Neither is required to open the review queue.
