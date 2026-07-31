# Replicate HTTP API Reference

Source: https://replicate.com/docs/reference/http  
Base URL: `https://api.replicate.com/v1`  
Auth header: `Authorization: Bearer r8_<token>`

## Authentication

All requests require:
```
Authorization: Bearer <token>
```
Older `Token <token>` format also accepted but `Bearer` is preferred.  
Tokens start with `r8_`.

## Endpoints

### Account
- `GET /account` — authenticated user info (`username`, `name`, `type`, `github_url`)

### Models
- `GET /models` — list public models (cursor-paginated; `.results[]`, `.next`)
- `GET /models/<owner>/<name>` — model details (includes `latest_version.id`)
- `GET /models/<owner>/<name>/versions` — list versions (`.results[].id`, `.results[].created_at`)
- `GET /models/<owner>/<name>/versions/<version_id>` — version detail with full OpenAPI schema
  - Input params: `.openapi_schema.components.schemas.Input.properties`
  - Output type: `.openapi_schema.components.schemas.Output`
- `POST /models` — create a model (requires billing)
- `PATCH /models/<owner>/<name>` — update model metadata
- `DELETE /models/<owner>/<name>` — delete model
- `GET /models/<owner>/<name>/readme` — model README

### Search (beta)
- `GET /search?query=<q>&limit=<n>` — search models, collections, docs
  - Response: `{ query, models: [{model, metadata}], collections, pages }`
  - `metadata.score`, `metadata.tags`, `metadata.generated_description`

### Predictions
- `POST /predictions` — create prediction
  - Body: `{ "version": "<64-hex-id>", "input": {...} }`
  - Or: `{ "version": "owner/name", "input": {...} }` for official models
  - Or: `{ "version": "owner/name:version", "input": {...} }`
  - Header `Prefer: wait=60` — synchronous mode, waits up to 60s for result
  - Header `Cancel-After: 30s` — auto-cancel after duration
  - Optional: `"webhook"`, `"webhook_events_filter"`, `"stream"` (deprecated)
- `POST /models/<owner>/<name>/predictions` — create prediction using official model
  - Body: `{ "input": {...} }` (no version needed for official models)
- `GET /predictions/<id>` — get prediction status
- `GET /predictions` — list your predictions (`.results[]`, `.next`)
- `POST /predictions/<id>/cancel` — cancel a prediction

#### Prediction statuses
`starting` → `processing` → `succeeded` | `failed` | `canceled`

Terminal states: `succeeded`, `failed`, `canceled`

#### Prediction object fields
- `id`, `status`, `model`, `version`, `input`, `output`, `error`, `logs`
- `created_at`, `started_at`, `completed_at`
- `urls.get` — poll URL; `urls.cancel` — cancel URL; `urls.stream` — SSE stream URL

### Trainings
- `POST /trainings` — create a training (fine-tune a model)
- `GET /trainings/<id>` — get training
- `GET /trainings` — list your trainings
- `POST /trainings/<id>/cancel` — cancel a training

### Deployments
- `POST /deployments` — create a deployment
- `GET /deployments/<owner>/<name>` — get deployment
- `GET /deployments` — list your deployments
- `PATCH /deployments/<owner>/<name>` — update deployment
- `DELETE /deployments/<owner>/<name>` — delete deployment
- `POST /deployments/<owner>/<name>/predictions` — create prediction via deployment

### Hardware
- `GET /hardware` — list available hardware SKUs
  - Response: `[{ "sku": "gpu-a100-large", "name": "Nvidia A100 (80GB) GPU" }, ...]`

### Collections
- `GET /collections` — list curated model collections (`.results[].slug`, `.name`)
- `GET /collections/<slug>` — get collection + its models

### Webhooks
- `GET /webhooks/default/secret` — get signing secret for default webhook

## Sync Mode (Prefer: wait)

Adding `Prefer: wait=60` blocks the POST request for up to 60 seconds.  
If the model finishes within that window, the response is the completed prediction.  
Otherwise the response has `status: "starting"` and you must poll.

```bash
curl -s -X POST \
  -H 'Prefer: wait=60' \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"version":"...", "input":{"prompt":"..."}}' \
  https://api.replicate.com/v1/predictions
```

## Polling Pattern

```
POST /v1/predictions   → { id, status: "starting" | "processing" | "succeeded" ... }
  if not terminal:
    loop:
      GET /v1/predictions/<id>  → { status, output, error }
      sleep 2s
      if status in {succeeded, failed, canceled}: break
```

## Pagination

List endpoints return:
```json
{ "results": [...], "next": "https://api.replicate.com/v1/predictions?cursor=..." }
```
Follow `.next` URL to get the next page. `null` means no more pages.

## Input Types

Model inputs are defined by `openapi_schema.components.schemas.Input.properties`.  
Common types:
- `string` — text, prompt, image URL
- `integer` / `number` — numeric params
- `boolean`
- `string` with `format: uri` — file URL (must be publicly accessible HTTPS URL or data URL)
- Objects/arrays — passed as JSON

Files: pass as HTTPS URLs (or data URLs ≤256 KB). The Replicate file upload API
(`POST /v1/files`) can host files for you if needed.

## Error format

```json
{ "detail": "error message here" }
```
HTTP 422 for validation errors. HTTP 401 for auth. HTTP 404 for not found.

## Verified live (with read-only token r8_4UKb...)

All GET endpoints below were verified to return expected data:
- `GET /account` → `{ type, username, name, github_url }` ✓
- `GET /predictions` → `{ results: [{id, status, model}], next }` ✓
- `GET /predictions/<id>` → full prediction object ✓
- `GET /models/stability-ai/sdxl` → model with `latest_version.id` ✓
- `GET /models/stability-ai/sdxl/versions/<id>` → version with `openapi_schema` ✓
- `GET /hardware` → array of `{ sku, name }` ✓
- `GET /models` → paginated list ✓
- `GET /collections` → 39 collections ✓
- `GET /search?query=flux` → `{ models: [{model, metadata}], collections, pages }` ✓
- `GET /trainings` → list ✓
- `GET /deployments` → list (empty for this account) ✓
