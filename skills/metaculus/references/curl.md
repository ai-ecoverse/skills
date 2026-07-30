# Metaculus API — curl reference

Base URL: `https://www.metaculus.com/api`  (a legacy `/api2` alias also exists).
Interactive docs (Swagger, Cloudflare-gated in headless clients): https://www.metaculus.com/api/

## Authentication

Every request needs a token. Create one at
<https://www.metaculus.com/accounts/settings/> (API section) and pass it as an
`Authorization: Token <token>` header. The bare API root and most endpoints
reject anonymous access ("The API is only available to authenticated users").

```sh
TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AUTH="-H Authorization: Token $TOKEN"

# who am I
curl -s "https://www.metaculus.com/api/users/me/" -H "Authorization: Token $TOKEN"
```

## Reading questions / posts

Questions live inside **posts**. A post has an `id` (the number in the page URL)
and, for a single question, a nested `question` object with its **own** `id`.
**The post id and the question id are usually different** — you read by post id
but you **forecast by question id** (`.question.id`).

```sh
# List posts (paginated: count/next/previous/results)
curl -s "https://www.metaculus.com/api/posts/?limit=20" -H "Authorization: Token $TOKEN"

# Useful query params:
#   search=<text>            full-text search
#   statuses=open|closed|resolved|upcoming|pending   (repeatable)
#   forecast_type=binary|multiple_choice|numeric|date|group
#   tournaments=<id>         filter to a tournament/project id
#   order_by=-nr_forecasters|-published_at|-created_at|hotness|...   (prefix - = desc)
#   limit / offset           pagination
curl -s "https://www.metaculus.com/api/posts/?statuses=open&forecast_type=binary&order_by=-nr_forecasters&limit=5" \
  -H "Authorization: Token $TOKEN"

# Single post (includes .question with resolution criteria, fine print, scaling)
curl -s "https://www.metaculus.com/api/posts/44798/" -H "Authorization: Token $TOKEN"

# Include the community prediction / aggregations:
#   NOTE: Metaculus hides the community prediction until the calling account has
#   itself forecast on that question — expect null centers otherwise.
curl -s "https://www.metaculus.com/api/posts/44798/?with_cp=true" -H "Authorization: Token $TOKEN"
# Community prediction lives at:
#   .question.aggregations.recency_weighted.latest.centers          (array)
#   .question.aggregations.recency_weighted.latest.forecaster_count
#   .question.aggregations.recency_weighted.latest.interval_lower_bounds / interval_upper_bounds
```

## Submitting a forecast

`POST /api/questions/forecast/` with a **JSON array** of forecast objects (you can
submit several at once). Each object keys on the **question id** (`.question.id`),
NOT the post id. The value field depends on the question type:

| Question type      | Value field                     | Shape / constraints                                   |
|--------------------|---------------------------------|-------------------------------------------------------|
| `binary`           | `probability_yes`               | number in **0.001 – 0.999**                            |
| `multiple_choice`  | `probability_yes_per_category`  | object `{ "<option>": <prob>, ... }` summing to ~1     |
| `numeric` / `date` | `continuous_cdf`                | array of **201** increasing values 0..1, step ≤ 0.2    |

```sh
# Binary
curl -s -X POST "https://www.metaculus.com/api/questions/forecast/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '[{"question":44945,"probability_yes":0.65}]'

# Multiple choice
curl -s -X POST "https://www.metaculus.com/api/questions/forecast/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '[{"question":123,"probability_yes_per_category":{"Yes":0.6,"No":0.4}}]'

# Continuous (numeric or date) — 201-point CDF
curl -s -X POST "https://www.metaculus.com/api/questions/forecast/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '[{"question":123,"continuous_cdf":[/* 201 increasing values */]}]'
```

Validation errors come back as HTTP 400 with `non_field_errors`, e.g.
`"probability_yes should be between 0.001 and 0.999"`.

## Withdrawing a forecast

`POST /api/questions/withdraw/` with an array of `{ "question": <question_id> }`.

```sh
curl -s -X POST "https://www.metaculus.com/api/questions/withdraw/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '[{"question":44945}]'
```

## Comments

```sh
# List comments — the list endpoint is restricted: you MUST scope it to your own
# user id (author=<your id>) and/or author_is_staff=true, else HTTP 403.
curl -s "https://www.metaculus.com/api/comments/?author=112033&limit=20" \
  -H "Authorization: Token $TOKEN"
curl -s "https://www.metaculus.com/api/comments/?post=44975&author=112033" \
  -H "Authorization: Token $TOKEN"

# Create a comment on a post
curl -s -X POST "https://www.metaculus.com/api/comments/create/" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"on_post":44975,"text":"My reasoning...","is_private":false}'
# Optional: "parent_id":<comment_id> to reply in a thread.
```

## Tournaments / projects

```sh
# List tournaments (returns a plain array, not paginated)
curl -s "https://www.metaculus.com/api/projects/tournaments/" -H "Authorization: Token $TOKEN"

# One tournament, by numeric id or slug
curl -s "https://www.metaculus.com/api/projects/tournaments/aibq4/" -H "Authorization: Token $TOKEN"

# All questions in a tournament (via the posts filter)
curl -s "https://www.metaculus.com/api/posts/?tournaments=32506&limit=50" -H "Authorization: Token $TOKEN"
```

## Notes & gotchas

- **post id ≠ question id.** Read by post id (`/posts/<post_id>/`); forecast/withdraw
  by `.question.id`. For group/conditional posts, `.question` is null and the
  sub-questions live under `.group_of_questions[]` / `.conditional`.
- **Community prediction is gated:** `?with_cp=true` returns `centers: null` until the
  authenticated account has itself forecast on the question.
- **Restricted endpoints** (HTTP 403 for normal tokens): unrestricted `/api/comments/`
  listing, `/api/aggregation_explorer/`. Contact support@metaculus.com for access.
- Rates/values: binary probabilities are clamped to 0.001–0.999; continuous CDFs
  must be exactly 201 monotonic points with per-step increase ≤ 0.2.
- The Swagger spec at `/api/` and `/static/openapi.*.yml` sits behind a Cloudflare
  JS challenge, so it is not fetchable from a plain headless `curl`; use a browser.
