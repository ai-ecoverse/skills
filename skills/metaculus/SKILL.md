---
name: metaculus
description: Interact with the Metaculus forecasting platform via its REST API — browse and search forecasting questions, read question detail and resolution criteria, submit or withdraw forecasts (binary, multiple-choice, and continuous), read and post comments, and list tournaments and their questions. Use when the user mentions Metaculus, forecasting questions, prediction questions, community predictions, forecasting tournaments (e.g. the AI Forecasting Benchmark / FutureEval bot tournaments), wants to make or update a forecast, check how a question is resolving, or query anything from metaculus.com without clicking through the site. Activate on "Metaculus", "forecast this question", "prediction market question", "community prediction", "forecasting tournament", "submit a forecast", "metaculus question".
allowed-tools: bash
---

# Metaculus

CLI access to the [Metaculus](https://www.metaculus.com) forecasting API:
browse/search questions, read detail, submit and withdraw forecasts, comment,
and list tournaments.

## Setup / auth

Get a personal API token from <https://www.metaculus.com/accounts/settings/>
(API section), then store it once:

```sh
metaculus auth <token>        # saved to git-ignored skill config
metaculus auth --show         # show masked stored token
```

Token resolution order: `--token <t>` flag | `METACULUS_TOKEN` env var | stored
config. Almost every endpoint requires authentication.

## Commands

```sh
metaculus me                                   # your account profile

# Browse / search questions (posts)
metaculus questions [--search q] [--status open|closed|resolved|upcoming] \
                    [--type binary|multiple_choice|numeric|date|group] \
                    [--tournament <id|slug>] [--order-by <field>] \
                    [--limit n] [--offset n] [--json]

# One question in detail (--cp adds the community prediction, when visible)
metaculus question <post_id> [--cp] [--json]

# Forecast (see "Forecasting" below — uses the QUESTION id, not the post id)
metaculus forecast <question_id> <prob>            # binary, 0.001–0.999
metaculus forecast <question_id> --data '<json>'   # MC / continuous
metaculus withdraw <question_id>

# Comments
metaculus comments [--post <id>] [--author me|<id>] [--limit n] [--json]
metaculus comment <post_id> <text> [--private] [--parent <comment_id>]

# Tournaments / projects
metaculus tournaments [--json]
metaculus tournament <id|slug> [--json]

# Raw API passthrough for anything not wrapped above
metaculus api <METHOD> <path> [--data '<json>'] [--query k=v ...] [--json]
```

## Forecasting

Questions live inside **posts**. A post has an id (the number in the page URL);
its nested question has its **own** id. **You read by post id but forecast by
question id.** `metaculus question <post_id>` prints both `post_id` and
`question_id` — use `question_id` for `forecast`/`withdraw`.

Value field by question type:

| Type              | How to submit                                                              |
|-------------------|----------------------------------------------------------------------------|
| `binary`          | `metaculus forecast <qid> 0.65`                                            |
| `multiple_choice` | `metaculus forecast <qid> --data '{"probability_yes_per_category":{"Yes":0.6,"No":0.4}}'` |
| `numeric`/`date`  | `metaculus forecast <qid> --data '{"continuous_cdf":[…201 increasing values 0..1…]}'` |

Constraints: binary probabilities clamp to **0.001–0.999**; continuous CDFs must
be exactly **201** monotonically-increasing points (per-step increase ≤ 0.2).

Forecasting is a real mutation against the user's Metaculus track record — get
explicit confirmation before submitting, and prefer showing the user the value
first.

## Gotchas

- **post id ≠ question id** (see above). Group/conditional posts have `question:
  null` and expose sub-questions under `.group_of_questions[]` / `.conditional`.
- **Community prediction is gated:** `--cp` / `?with_cp=true` returns `null`
  centers until the calling account has itself forecast on that question.
- **Restricted endpoints (HTTP 403):** unrestricted `/api/comments/` listing (scope
  to `--author me`), and `/api/aggregation_explorer/`. Contact
  support@metaculus.com for broader access.
- The Swagger UI at `/api/` sits behind a Cloudflare JS challenge — open it in a
  browser, not headless curl.

## Reference

`references/curl.md` — the underlying REST endpoints as raw `curl` commands
(auth, question read/search, forecast/withdraw payload shapes, comments,
tournaments) with the response fields to look for.
