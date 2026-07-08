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

`oauth-token github` is the single entry point for GitHub credentials in SLICC. Get a token, then set it once for the tool you're using:

```bash
oauth-token github                       # default scopes (repo, read:org)
oauth-token github --scope workflow       # add workflow scope (for .github/workflows/)
oauth-token github --scope workflow,repo  # multiple extra scopes

git config github.token "$(oauth-token github)"   # persists the token for gh.jsh and git push/pull
```

| Tool | How it gets the token |
|---|---|
| `gh` (this skill's CLI) | Reads `git config github.token` automatically once set above. |
| `git push`/`git pull` | Same config key — set once, both tools pick it up. |
| Raw `fetch`/`curl` | Not persisted — pass it explicitly per call: `curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/...` |

```bash
# gh commands authenticate transparently once git config github.token is set:
gh pr list ai-ecoverse/skills
gh content put README.md ./local.md "update" --branch=feat ai-ecoverse/skills
```

### Scope escalation

The default token covers most operations. Request additional scopes when needed, then re-run the `git config github.token "$(oauth-token github --scope ...)"` setup above with the escalated token:

| Scope | When needed |
|-------|-------------|
| `workflow` | Pushing/modifying `.github/workflows/` files |
| `delete_repo` | Deleting repositories |
| `admin:org` | Managing organization settings |

```bash
git config github.token "$(oauth-token github --scope workflow)"
git push origin my-branch   # now allowed to push workflow changes
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

### Keeping a scoop in the loop on a PR until merged

A real GitHub repository webhook can push PR events (new review comments, CI completing, the PR closing) to a scoop the moment they happen, instead of polling `pr view`/`run list` in a loop. See [`references/webhook-pr-monitoring.md`](references/webhook-pr-monitoring.md) for the full recipe — setup (SLICC `webhook create` + a real GitHub repo webhook), the self-echo-detection pattern a scoop needs when watching its own PR, and the stop condition for tearing the webhook down once the PR is merged or closed.

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
