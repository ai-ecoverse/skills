# Recipe: keeping a scoop in the loop on a PR until merged

## Primary path: `gh pr watch`

`gh.jsh` (this skill's CLI) has a first-class `pr watch`/`pr unwatch` pair that automates everything in this recipe — wiring up a SLICC webhook, registering it as a real GitHub repository webhook, and tearing both down again. Prefer this over doing it by hand:

```bash
gh.jsh pr watch 151 --scoop <your-scoop-name>
# -> Watching PR #151 in owner/repo
#    SLICC webhook:  <id> (pr-owner-repo-151-watch) → <your-scoop-name>
#    GitHub hook:    <id>
#    Events:         pull_request, pull_request_review, pull_request_review_comment,
#                     issue_comment, check_run, check_suite, status
#    Stop watching:  gh pr unwatch 151 owner/repo

gh.jsh pr watch 151 --filter "e => e.body.action !== 'synchronize'" --scoop <your-scoop-name>
# same, but drops noisy `synchronize` events before they reach the scoop
# (passes straight through to `webhook create --filter`, see automation/SKILL.md)

gh.jsh pr unwatch 151
# -> Stopped watching PR #151 in owner/repo
#    Removed SLICC webhook:  <id>
#    Removed GitHub hook:    <id>
```

`pr watch` is idempotent: running it again against a PR that's already being watched (matched by a deterministic webhook name, `pr-<owner>-<repo>-<number>-watch`) is a no-op that reports the existing webhook instead of creating a duplicate — see `/workspace/skills/automation/SKILL.md`'s "Don't" section on why duplicate near-identical registrations are worth avoiding. `pr create` prints a `gh pr watch <num>` tip using the real new PR number as soon as a PR is opened, so the feature is discoverable at exactly the moment it's useful.

**Still required, and still manual:** the self-echo-detection pattern below — `pr watch` sets up delivery, but a scoop receiving the resulting licks still needs to check live PR/comment state before reacting, exactly as described in the "Self-echo-detection" section. `pr watch` doesn't (and can't) do that part for you; it lives in whatever code handles the incoming lick.

**Also still manual (for now):** automatically calling `pr unwatch` when a scoop detects the PR-closed stop condition. `pr watch`'s teardown half exists and works, but nothing currently wires "I noticed `action: closed` on a watched PR" to "call `gh pr unwatch` automatically" — a scoop's own lick-handling code needs to make that call explicitly. See "Stop condition" below for the exact detection logic to use when you do.

## How it works under the hood

`pr watch` is a thin two-step wrapper (see `gh.jsh`'s `prWatch()`/`prUnwatch()` for the exact implementation):

1. `webhook create --scoop <scoop> --name pr-<owner>-<repo>-<num>-watch [--filter <js>]` — allocates a SLICC-side webhook endpoint and points it at the given scoop.
2. `POST /repos/<owner>/<repo>/hooks` with `events: [pull_request, pull_request_review, pull_request_review_comment, issue_comment, check_run, check_suite, status]` and `config: { url: <step 1's URL>, content_type: "json" }` — registers that URL as a real GitHub repository webhook, using the same token `gh.jsh` already uses for everything else (`skill.token('github')` / `GITHUB_TOKEN` fallback). No extra OAuth scope was needed in practice for this to succeed on a repo the token's account has admin/write access to.

`pr unwatch` reverses both steps: it looks up the GitHub-side hook whose `config.url` matches the known SLICC webhook, deletes it via the Contents/Hooks API, then deletes the SLICC webhook itself.

## Self-echo-detection — the important part, independent of watch vs. manual setup

Once a webhook (however it was created) is live, *every* PR event fires a lick back to the scoop — including events the scoop itself just caused. Pushing a fix commit triggers a `pull_request` `synchronize` lick, a `check_suite`/`check_run` pair per CI job as it queues and completes, and if the scoop also replies to review comments, a `pull_request_review` + `pull_request_review_comment` pair per reply. In a real session watching PR #150 this arrived as a burst of eight-plus licks describing a batch of work the scoop had just finished doing seconds earlier.

**A scoop with a live PR webhook must assume any given lick might describe its own prior action, and check before reacting** — otherwise it risks re-doing finished work, or worse, replying to its own reply in an infinite loop. The pattern that worked:

1. On receiving a PR-related lick, re-fetch current live state rather than acting on the payload at face value — `GET /repos/<owner>/<repo>/pulls/<number>` for the PR's current `head.sha`/`state`/`mergeable_state`, and `GET /repos/<owner>/<repo>/pulls/<number>/comments` for the current comment/reply count and their `in_reply_to_id`s.
2. Compare that live state against what's already been done/reported. If the head SHA matches the last commit already pushed, and the comment count matches what was already replied to, the lick is an echo of already-completed work — no action needed, report tersely (or don't report at all if nothing changed) rather than re-triggering the same work.
3. Only treat a lick as actionable if it describes state the scoop hasn't already accounted for (a genuinely new review comment with no reply yet, a new commit pushed by someone else, CI finishing on a commit that hasn't been evaluated yet).

Concretely, in the session this recipe is based on: after pushing a fix commit and replying to four review comment threads on PR #150, a cascade of `pull_request` (synchronize), `check_run`/`check_suite` (×3, as CI ran), and `pull_request_review`/`pull_request_review_comment` (×4, as the replies posted) licks arrived. Each was resolved by re-fetching the PR (`state: "open"`, same `head.sha` as the commit just pushed) and the comments list (same count as just posted, all replies correctly threaded via `in_reply_to_id`) — confirming these were retrospective echoes, not new external input, and reporting "no action needed" instead of looping.

## Stop condition — detecting "done" and tearing down

> **Not yet observed live.** This stop condition is designed from GitHub's documented `pull_request` webhook payload shape, but the PR used as the worked example (#150) was still open at the time of writing — this code path has not actually fired and been watched end-to-end yet. Treat it as reviewed-but-unverified and sanity-check against a real merge/close event before relying on it unattended.

The `pull_request` webhook event fires with `action: "closed"` both when a PR is merged and when it's closed without merging — distinguish the two cases using `pull_request.merged`:

- `action == "closed"` and `pull_request.merged == true` → merged successfully. This is the normal terminal state.
- `action == "closed"` and `pull_request.merged == false` → closed without merging (abandoned, superseded, or rejected). Also terminal, but worth a different report to whoever's watching (something didn't land) rather than treating it the same as a merge.

Either way, once the PR is closed (merged or not), stop watching — now a one-liner instead of two raw API calls:

```bash
gh.jsh pr unwatch <num> <owner>/<repo>
```

## Manual equivalent (if you need it outside `gh.jsh`)

Everything `pr watch`/`pr unwatch` do can be done by hand with plain `webhook`/`curl` calls, which is how this recipe was originally worked out, before it was automated into `gh.jsh`.

**Setup:**

```bash
webhook create --scoop github-skill-migration-scoop --name pr-150-watcher
# -> prints a callable URL, e.g.:
# https://www.sliccy.ai/webhook/eaf5de0e-2967-4aed-8d09-1201bca45028.d3d7ca28540b61c2932ceef7408a2b93e876/qs7tes6s6dnq
webhook list
# qs7tes6s6dnq  pr-150-watcher  <url>  -> github-skill-migration-scoop

TOKEN=$(oauth-token github)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks \
  -d '{
    "name": "web",
    "active": true,
    "events": [
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
      "check_run",
      "check_suite",
      "status"
    ],
    "config": {
      "url": "https://www.sliccy.ai/webhook/eaf5de0e-2967-4aed-8d09-1201bca45028.d3d7ca28540b61c2932ceef7408a2b93e876/qs7tes6s6dnq",
      "content_type": "json"
    }
  }'
```

GitHub returns the new hook's numeric `id` in the response — keep it, it's needed to tear the hook down later (`DELETE /repos/<owner>/<repo>/hooks/<id>`).

**Teardown:**

```bash
# Stop the SLICC-side delivery first — a webhook with no live PR behind it is exactly
# the "orphaned watcher" case /workspace/skills/automation/SKILL.md's "Don't" section
# warns about.
webhook delete qs7tes6s6dnq

# Remove the GitHub-side repo hook too, so it doesn't linger as a dangling
# registration on the real repo:
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks/650597302
```

**Minimal end-to-end manual recipe, using the real IDs from the session this was worked out in:**

```bash
# 1. Wire up delivery (SLICC side)
webhook create --scoop github-skill-migration-scoop --name pr-150-watcher
# -> webhook id: qs7tes6s6dnq, scoop: github-skill-migration-scoop

# 2. Wire up the source (GitHub side) — see the curl body above
TOKEN=$(oauth-token github)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks -d '{...}'
# -> GitHub hook id: 650597302

# 3. Do normal PR work (push commits, reply to reviews) — licks will arrive for
#    every event, including echoes of this scoop's own actions (see above).

# 4. On each lick: re-fetch live PR + comments state before deciding whether to act.

# 5. On a `pull_request` lick with action=="closed": check pull_request.merged, then
#    tear down both sides (or just run `gh pr unwatch <num> <owner>/<repo>` if the
#    watch was set up via `gh pr watch` instead of by hand):
webhook delete qs7tes6s6dnq
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks/650597302
```
