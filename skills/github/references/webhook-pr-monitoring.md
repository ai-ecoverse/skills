# Recipe: keeping a scoop in the loop on a PR until merged

Polling `pr view`/`run list` in a loop works, but a real GitHub repository webhook pointed at a SLICC `webhook` endpoint lets a scoop react to PR events (new review comments, CI completing, the PR closing) the moment they happen, with no polling. This recipe is grounded in a real session: a scoop opened a PR, wired up this exact webhook, then triaged incoming review comments and pushed fix commits while the webhook was live and firing.

**1. Setup — two separate registration steps.**

First, allocate a SLICC-side webhook endpoint and point it at the scoop that should receive the events (see `/workspace/skills/automation/SKILL.md` for the full `webhook` command reference):

```bash
webhook create --scoop github-skill-migration-scoop --name pr-150-watcher
# -> prints a callable URL, e.g.:
# https://www.sliccy.ai/webhook/eaf5de0e-2967-4aed-8d09-1201bca45028.d3d7ca28540b61c2932ceef7408a2b93e876/qs7tes6s6dnq
webhook list
# qs7tes6s6dnq  pr-150-watcher  <url>  -> github-skill-migration-scoop
```

Second, register that URL as a **real GitHub repository webhook** so GitHub actually calls it. The default `oauth-token github` token was sufficient for this in practice — no extra `--scope admin:repo_hook` request was needed (repo-admin access via org membership was enough for `POST .../hooks` on `ai-ecoverse/skills` to succeed):

```bash
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

That event list is deliberately the *actual* set used in the live session, not a generic recommendation: `pull_request` (opened/synchronize/closed), `pull_request_review` + `pull_request_review_comment` (review submissions and inline comment threads/replies), `issue_comment` (top-level PR comments — PRs are issues under the hood), `check_run` + `check_suite` (CI progress and completion), and `status` (legacy commit status updates some CI systems still use). GitHub returns the new hook's numeric `id` in the response — keep it, it's needed to tear the hook down later (`DELETE /repos/<owner>/<repo>/hooks/<id>`).

**2. The self-echo-detection requirement — the important part.**

Once the hook is live, *every* PR event fires a lick back to the scoop — including events the scoop itself just caused. Pushing a fix commit triggers a `pull_request` `synchronize` lick, a `check_suite`/`check_run` pair per CI job as it queues and completes, and if the scoop also replies to review comments, a `pull_request_review` + `pull_request_review_comment` pair per reply. In the live session this arrived as a burst of eight-plus licks describing a batch of work the scoop had just finished doing seconds earlier.

**A scoop with a live PR webhook must assume any given lick might describe its own prior action, and check before reacting** — otherwise it risks re-doing finished work, or worse, replying to its own reply in an infinite loop. The pattern that worked:

1. On receiving a PR-related lick, re-fetch current live state rather than acting on the payload at face value — `GET /repos/<owner>/<repo>/pulls/<number>` for the PR's current `head.sha`/`state`/`mergeable_state`, and `GET /repos/<owner>/<repo>/pulls/<number>/comments` for the current comment/reply count and their `in_reply_to_id`s.
2. Compare that live state against what's already been done/reported. If the head SHA matches the last commit already pushed, and the comment count matches what was already replied to, the lick is an echo of already-completed work — no action needed, report tersely (or don't report at all if nothing changed) rather than re-triggering the same work.
3. Only treat a lick as actionable if it describes state the scoop hasn't already accounted for (a genuinely new review comment with no reply yet, a new commit pushed by someone else, CI finishing on a commit that hasn't been evaluated yet).

Concretely, in the session this recipe is based on: after pushing a fix commit and replying to four review comment threads on PR #150, a cascade of `pull_request` (synchronize), `check_run`/`check_suite` (×3, as CI ran), and `pull_request_review`/`pull_request_review_comment` (×4, as the replies posted) licks arrived. Each was resolved by re-fetching the PR (`state: "open"`, same `head.sha` as the commit just pushed) and the comments list (same count as just posted, all replies correctly threaded via `in_reply_to_id`) — confirming these were retrospective echoes, not new external input, and reporting "no action needed" instead of looping.

**3. Stop condition — detecting "done" and tearing down.**

> **Not yet observed live.** Everything above happened in a real session with a real webhook. This stop condition is designed from GitHub's documented `pull_request` webhook payload shape, but the PR used as the worked example (#150) was still open at the time of writing — this code path has not actually fired and been watched end-to-end yet. Treat it as reviewed-but-unverified and sanity-check against a real merge/close event before relying on it unattended.

The `pull_request` webhook event fires with `action: "closed"` both when a PR is merged and when it's closed without merging — distinguish the two cases using `pull_request.merged`:

- `action == "closed"` and `pull_request.merged == true` → merged successfully. This is the normal terminal state.
- `action == "closed"` and `pull_request.merged == false` → closed without merging (abandoned, superseded, or rejected). Also terminal, but worth a different report to whoever's watching (something didn't land) rather than treating it the same as a merge.

Either way, once the PR is closed (merged or not), stop watching:

```bash
# Stop the SLICC-side delivery first — a webhook with no live PR behind it is exactly
# the "orphaned watcher" case /workspace/skills/automation/SKILL.md's "Don't" section
# warns about.
webhook delete qs7tes6s6dnq

# If the GitHub-side repo hook was created solely for this PR's lifecycle (as opposed
# to a standing hook meant to watch the whole repo long-term), remove it too, so it
# doesn't linger as a dangling registration on the real repo:
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks/650597302
```

**4. Minimal end-to-end recipe, using this session's real IDs as the worked example:**

```bash
# 1. Wire up delivery (SLICC side)
webhook create --scoop github-skill-migration-scoop --name pr-150-watcher
# -> webhook id: qs7tes6s6dnq, scoop: github-skill-migration-scoop

# 2. Wire up the source (GitHub side) — see the curl body under "Setup" above
TOKEN=$(oauth-token github)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks -d '{...}'
# -> GitHub hook id: 650597302

# 3. Do normal PR work (push commits, reply to reviews) — licks will arrive for
#    every event, including echoes of this scoop's own actions.

# 4. On each lick: re-fetch live PR + comments state before deciding whether to act
#    (see "self-echo-detection" above). Most licks during active work on your own PR
#    will turn out to be echoes — that's expected, not a bug.

# 5. On a `pull_request` lick with action=="closed": check pull_request.merged, then
#    tear down both sides:
webhook delete qs7tes6s6dnq
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/ai-ecoverse/skills/hooks/650597302
```
