---
name: metaculus
description: Interact with the Metaculus forecasting platform via its REST API — browse and search forecasting questions, read question detail and resolution criteria, submit or withdraw forecasts (binary, multiple-choice, and continuous), list your own forecasts and which are still active vs auto-withdrawn, read and post comments, and list tournaments and their questions. A companion `metaculus-ext` reads the community prediction (which the API gates) from a logged-in browser tab and ranks how far your active forecasts diverge from the crowd. Use when the user mentions Metaculus, forecasting questions, prediction questions, community predictions, forecasting tournaments (e.g. the AI Forecasting Benchmark / FutureEval bot tournaments), wants to make or update a forecast, see their current/active forecasts, compare their forecasts to the community, check how a question is resolving, or query anything from metaculus.com without clicking through the site. Activate on "Metaculus", "forecast this question", "prediction market question", "community prediction", "forecasting tournament", "submit a forecast", "my metaculus forecasts", "out on a limb", "metaculus question".
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

# One question in detail (--cp adds the community prediction, when visible;
# also surfaces YOUR forecast and whether it is still active — see "My forecasts")
metaculus question <post_id> [--cp] [--json]

# Your own forecasts on open questions, flagged active vs auto-withdrawn
metaculus mine [--status active|withdrawn|all] [--json]

# Forecast (see "Forecasting" below — uses the QUESTION id, not the post id)
metaculus forecast <question_id> <prob> --confirm            # binary, 0.001–0.999
metaculus forecast <question_id> --data '<json>' --confirm   # MC / continuous
metaculus withdraw <question_id> --confirm

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
| `binary`          | `metaculus forecast <qid> 0.65 --confirm`                                  |
| `multiple_choice` | `metaculus forecast <qid> --data '{"probability_yes_per_category":{"Yes":0.6,"No":0.4}}' --confirm` |
| `numeric`/`date`  | `metaculus forecast <qid> --data '{"continuous_cdf":[…201 increasing values 0..1…]}' --confirm` |

Constraints: binary probabilities clamp to **0.001–0.999**; continuous CDFs must
be exactly **201** monotonically-increasing points (per-step increase ≤ 0.2).

`forecast` and `withdraw` are real mutations against the user's Metaculus track
record, so they **require `--confirm`**. Without it, the command prints a preview
of the exact payload and submits nothing — show the user that preview and get
explicit approval before re-running with `--confirm`. A `--data` payload whose
embedded `question` id contradicts the positional id is rejected (no silent
forecast on the wrong question).

## My forecasts & auto-withdrawal

Metaculus **auto-withdraws** stale forecasts (each forecast has a
prediction-expiration; once it lapses your forecast stops counting toward the
community aggregate). The API exposes this on `question.my_forecasts.latest`:
an `end_time` in the **past** means the forecast is no longer standing, even
though the question is still open.

- `metaculus mine` lists your forecasts on open questions and flags each
  `active` vs `withdrawn`. Default `--status active` = the forecasts you're
  **currently** making; `--status withdrawn` / `all` for the rest.
- `metaculus question <id>` includes a `my_forecast` block with `active` and a
  human `status` ("withdrawn (auto-expired)").

Don't treat "questions I've ever forecast on and are still open" as "my current
predictions" — most may have auto-withdrawn.

## Community prediction & divergence (metaculus-ext)

A normal API token **cannot read the community prediction** — the
`aggregations.recency_weighted.latest` block comes back null regardless of auth
(same gating as the restricted `aggregation_explorer` endpoint). The website
shows it because it is server-rendered into the page.

`metaculus-ext` (a separate binary, so `metaculus` stays a clean API client)
reads the CP from a **logged-in www.metaculus.com browser tab** — exactly the
pattern `gcloud-ext` uses for the Cloud Console billing API. Open metaculus.com
signed in, then:

```sh
metaculus-ext cp <post_id> [post_id...] [--json]     # community prediction for questions
metaculus-ext divergence [--min-forecasters N] [--limit N] \
                         [--include-withdrawn] [--json]   # your active bets ranked by
                                                          # distance from the crowd
```

`divergence` combines the token API (your forecasts + active/withdrawn state)
with the browser session (the crowd's number) and ranks your **active** binary
forecasts by `|you − crowd|` — the real "out on a limb" metric. (Extremity ≠
divergence: a 1% forecast where the crowd is also at 1% is high-conviction but
not contrarian.) Requires an open, logged-in metaculus.com tab.

## Gotchas

- **post id ≠ question id** (see above). Group/conditional posts have `question:
  null` and expose sub-questions under `.group_of_questions[]` / `.conditional`.
- **A forecast on an open question may be auto-withdrawn** (see "My forecasts").
- **Community prediction is gated from the API** — use `metaculus-ext` with a
  logged-in browser tab (see above).
- **Restricted endpoints (HTTP 403):** unrestricted `/api/comments/` listing (scope
  to `--author me`), and `/api/aggregation_explorer/`. Contact
  support@metaculus.com for broader access.
- The Swagger UI at `/api/` sits behind a Cloudflare JS challenge — open it in a
  browser, not headless curl.
- **Credentials only go to metaculus.com:** the `api` passthrough refuses to
  attach the token to an absolute URL on any non-`metaculus.com` host, so a stray
  or malicious URL can't exfiltrate the token.

## Reference

`references/curl.md` — the underlying REST endpoints as raw `curl` commands
(auth, question read/search, forecast/withdraw payload shapes, comments,
tournaments) with the response fields to look for.
