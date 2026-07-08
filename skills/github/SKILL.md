---
name: github
description: >
  Interact with GitHub via gh.jsh — a lightweight GitHub CLI for SLICC agents.
  Use this skill for any GitHub task: listing or viewing pull requests, merging PRs,
  posting comments, checking out branches, viewing issues, inspecting workflow runs,
  listing releases, searching PRs, managing Actions variables, creating branches,
  pushing file content, archiving repos, or calling any GitHub API endpoint directly.
  Trigger on requests like "list open PRs", "check CI status", "merge this PR",
  "what issues are open", "show the latest release", "post a comment on PR #42",
  "set a repo variable", "archive this repo", "create a branch", "push this file",
  or any task involving a GitHub repository.
allowed_tools:
  - bash
---

# gh — GitHub CLI for SLICC Agents

`gh.jsh` is a Node.js GitHub CLI that wraps the GitHub REST API with clean formatted output, ANSI color, and sensible defaults. No `curl | jq` pipelines.

## Authentication

Three tools, one token source. `oauth-token github` is the single entry point for GitHub credentials in SLICC.

### Token basics

```bash
oauth-token github                       # default scopes (repo, read:org)
oauth-token github --scope workflow       # add workflow scope (for .github/workflows/)
oauth-token github --scope workflow,repo  # multiple extra scopes
```

Returns a fresh OAuth token string. Use it with any of the three GitHub tools:

### With `gh` (this skill's CLI)

`gh` reads the token from `git config github.token` automatically. Set it once:

```bash
git config github.token "$(oauth-token github)"
```

Then all `gh` commands authenticate transparently:
```bash
gh pr list ai-ecoverse/skills
gh content put README.md ./local.md "update" --branch=feat ai-ecoverse/skills
```

### With `git` (push/pull)

Same config key — `git push`/`pull` use the token from `git config github.token`:

```bash
git config github.token "$(oauth-token github)"
git push origin my-branch
```

For pushing workflow files (`.github/workflows/`), GitHub requires the `workflow` scope:
```bash
git config github.token "$(oauth-token github --scope workflow)"
git push origin my-branch   # now allowed to push workflow changes
```

### With raw `fetch`/`curl` (API calls)

For direct GitHub REST API calls outside of `gh`:
```bash
TOKEN=$(oauth-token github)
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/owner/repo
```

### Scope escalation

The default token covers most operations. Request additional scopes when needed:

| Scope | When needed |
|-------|-------------|
| `workflow` | Pushing/modifying `.github/workflows/` files |
| `delete_repo` | Deleting repositories |
| `admin:org` | Managing organization settings |

```bash
# Escalate for workflow file changes
git config github.token "$(oauth-token github --scope workflow)"

# Multiple scopes
TOKEN=$(oauth-token github --scope workflow,admin:org)
```

### Precedence

1. `git config github.token` (checked first by `gh` and `git push`)
2. `GITHUB_TOKEN` environment variable (fallback)

**Repo defaults** — most subcommands that act on a repo (e.g. `pr`, `issue`, `branch`, `content`, `run`, `release`, `search`, `vars`, `repo`) accept an optional trailing `owner/repo` argument. If omitted, the script infers it from the current directory's `git remote get-url origin`. Pass it explicitly to override. The `api` passthrough and utility commands like `auth` do **not** take a trailing repo — `api` requires a full REST path. The examples below show the short form; append `owner/repo` to repo-scoped commands to target a different repo.

## Running the script

```bash
/workspace/skills/github/scripts/gh.jsh <command> <subcommand> [args] [owner/repo]
```

---

## Common Workflows

### Create a PR from scratch

This is the most common multi-step flow. Follow these steps in order, validating each before proceeding. **Important:** `pr create` returns a PR number — capture it and use that exact value in later steps. Do not hard-code the example number `<PR_NUMBER>` shown below; replace it with the number printed by step 3 in your own session.

```bash
# 1. Create the branch
/workspace/skills/github/scripts/gh.jsh branch create my-feature owner/repo

# 2. Push file changes to that branch
/workspace/skills/github/scripts/gh.jsh content put src/index.js ./index.js "Add entry point" --branch=my-feature owner/repo

# 3. Open the PR — note the returned PR number, e.g. "Created PR #123"
/workspace/skills/github/scripts/gh.jsh pr create "My title" "PR body" my-feature owner/repo

# 4. Verify CI has started for that PR (substitute the real number for <PR_NUMBER>)
/workspace/skills/github/scripts/gh.jsh pr view <PR_NUMBER> owner/repo
/workspace/skills/github/scripts/gh.jsh run list owner/repo

# 5. Once CI is green, merge that same PR number
/workspace/skills/github/scripts/gh.jsh pr merge <PR_NUMBER> --squash owner/repo
```

**Validation checkpoints:**
- After `branch create`: confirm no error output before pushing content.
- After `pr create`: capture the new PR number from the command's output and reuse it in steps 4 and 5 — never reuse a number from another PR.
- After `pr view`: read the `Checks:` line in the output (e.g. `Checks:  3 passed`) — only proceed to merge when there are no `failed` or `pending` entries. If any check failed, inspect with `run view <id>` before proceeding.

### Review and merge an existing PR

Substitute `<PR_NUMBER>` with the actual PR number you intend to act on.

```bash
# Inspect the PR and its checks (look at the 'Checks:' line in the output)
/workspace/skills/github/scripts/gh.jsh pr view <PR_NUMBER> owner/repo

# Confirm CI is passing (cross-check the per-job status from 'run list')
/workspace/skills/github/scripts/gh.jsh run list owner/repo

# Post a comment then merge
/workspace/skills/github/scripts/gh.jsh pr comment <PR_NUMBER> "Automated: all checks passed, merging." owner/repo
/workspace/skills/github/scripts/gh.jsh pr merge <PR_NUMBER> --squash owner/repo
```

### Recipe: keeping a scoop in the loop on a PR until merged

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

---

## Command Reference

### Pull Requests

```bash
gh.jsh pr list
gh.jsh pr view 42
gh.jsh pr create "My title" "PR body text" my-feature-branch
gh.jsh pr create "My title" "PR body" my-branch --base=develop
gh.jsh pr create "My title" "PR body" my-branch --draft
gh.jsh pr merge 42                        # default: merge commit
gh.jsh pr merge 42 --squash
gh.jsh pr merge 42 --rebase
gh.jsh pr comment 42 "LGTM, merging now"
gh.jsh pr checkout 42                     # prints git fetch/checkout commands (does not execute)
```
`pr create`: `head` is the branch to merge from; `--base` defaults to the repo's default branch. Returns the PR number and URL.

---

### Issues

```bash
gh.jsh issue list
gh.jsh issue view 123
gh.jsh issue create "Title" "Body text"
gh.jsh issue create "Title" "Body text" --label=bug
gh.jsh issue create "Title" "Body text" --labels=bug,triage
```
Returns the new issue number and URL. `--label=` may be repeated; `--labels=` accepts a comma-separated list. Title and body are required; pass `""` for an empty body.

---

### Repository

```bash
gh.jsh repo view
gh.jsh repo archive owner/repo           # irreversible without admin unarchive
```

---

### Branches

```bash
gh.jsh branch create my-feature
gh.jsh branch create my-feature --from=develop
gh.jsh branch create my-feature --from=abc1234...
gh.jsh branch delete my-feature
```
Creates from the default branch (or `--from` ref/SHA). Use before `content put` to prepare a PR branch.

---

### File Content (Contents API)

```bash
gh.jsh content put README.md ./local-readme.md "Update README" --branch=my-feature
gh.jsh content put src/index.js ./index.js "Add entry point" --branch=my-feature owner/repo
```
Reads a local VFS file, base64-encodes it, and creates/updates it on the specified branch via the GitHub Contents API. Handles SHA lookup for existing files automatically. Use this to push file changes without git clone + push.

---

### Workflow Runs

```bash
gh.jsh run list
gh.jsh run view 12345678
```
`run view` shows run details, commit, and per-job status with duration.

---

### Releases

```bash
gh.jsh release list
```

---

### Search

```bash
gh.jsh search prs "fix login"
gh.jsh search prs "fix login" owner/repo
```
Uses GitHub search API. Returns PR number, title, repo, and state.

---

### Actions Variables

```bash
gh.jsh vars list
gh.jsh vars set MY_VAR "hello world"
```
Creates or updates the variable (PATCH if exists, POST if new).

---

### Raw API Passthrough

```bash
gh.jsh api /repos/owner/repo
gh.jsh api /repos/owner/repo/git/ref/heads/main --jq .object.sha
gh.jsh api /repos/owner/repo/git/refs -X POST -f ref=refs/heads/new-branch -f sha=abc123
```
Generic passthrough for any GitHub REST API endpoint. Supports `-X METHOD`, `-f key=value` (sent as JSON body on non-GET), and `--jq .path.to.field` for simple field extraction.

---

## Gotchas

The SLICC environment has a few quirks you'll only hit if you bypass `gh.jsh` and reach for raw `git` or `curl`. The skill's own commands route around all of these. See [`references/gotchas.md`](references/gotchas.md) for full details and copy-paste workarounds.

| Symptom | Cause | Quick fix |
|---|---|---|
| `git clone` aborts with `ENOENT mkdir <Foo.graffle>` | OPFS git can't `mkdir` directory-bundle children before the parent is ready | `git init` + `git fetch` + `core.sparseCheckout` excluding the bad path |
| `git clone --depth=1` rejects flag | SLICC `git` wrapper doesn't accept extra args | Use `init`+`fetch` instead of `clone` |
| `curl --data @file` returns `400 Problems parsing JSON` | The `@file` body read mangles bytes in this realm | Build and POST from `node` with `fetch()`, or use `gh.jsh api -f key=value` |
| Uploaded files arrive as Latin-1-of-UTF-8 mojibake on GitHub | `fs.readFile(path, 'utf8')` in this realm doesn't actually decode UTF-8 | Use `fs.readFileBinary` (real `Uint8Array`) before `btoa` |
| `cat`/`xxd`/`head -c` show corrupted bytes for a known-good file | Same shell I/O layer Latin-1↔UTF-8 round-trip | Verify via `playwright-cli eval` against `raw.githubusercontent.com` |
| Need to commit a symlink | `PUT /contents` always writes mode `100644` | Use Git Data API with `mode: 120000` and target path as blob content |
