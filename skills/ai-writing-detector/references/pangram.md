# Pangram AI detection

Optional classifier used by `pangram`. Docs: https://docs.pangram.com/api-reference/ai-detection

## Auth

`x-api-key` header. Resolution order:

1. `PANGRAM_API_KEY` environment variable
2. `apiKey` in this skill's `scripts/.config` (gitignored; set with `pangram login`)

Never pass the key on the command line.

## Endpoints

Base: `https://text.external-api.pangram.com`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/models` | Selectors available to this key (`default`, `pangram-4`, …) |
| `POST` | `/task` | Create an async job `{ text, model, public_dashboard_link }` → `{ task_id }` |
| `GET` | `/task/{task_id}` | Poll until `stage` is `STAGE_SUCCESS` or `STAGE_FAILED` |

Default model: `pangram-4`. Discover with `pangram models`; do not assume every key sees the same list.

## Result fields used by the CLI

| Field | Meaning |
|-------|---------|
| `headline` | Short classification (`AI Generated`, `AI Assisted`, `Human`) |
| `prediction_short` | `AI` / `Human` / `Mixed` |
| `prediction` | Long-form sentence |
| `fraction_ai` / `fraction_ai_assisted` / `fraction_human` | 0–1 |
| `windows[]` | Segment labels, `ai_assistance_score`, `confidence`, offsets |

## Review protocol

`pangram review --path FILE [--id ID]` writes a contribution object (see the review skill's `SOURCE_PROTOCOL.md`). Severity: `fail` if `prediction_short` is `AI`, `warn` if `Mixed`, `info` otherwise.
