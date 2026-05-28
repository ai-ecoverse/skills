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

## Setup

**Authentication** — preferred: use SLICC's OAuth provider:
```bash
export GITHUB_TOKEN=$(oauth-token github)
```
This works out of the box for SLICC agents — no manual PAT needed. Run `oauth-token github` once interactively if not yet authorized.

Alternatives (in precedence order: git config wins, then env var):
```bash
git config github.token <YOUR_PAT>     # persisted across shells
export GITHUB_TOKEN=<YOUR_PAT>          # session-scoped
```

**Repo defaults** — all commands accept an optional trailing `owner/repo` argument. If omitted, the script infers it from the current directory's `git remote get-url origin`. Pass it explicitly to override. The examples below show the short form; append `owner/repo` to any command to target a different repo.

## Running the script

```bash
/workspace/skills/github/gh.jsh <command> <subcommand> [args] [owner/repo]
```

---

## Common Workflows

### Create a PR from scratch

This is the most common multi-step flow. Follow these steps in order, validating each before proceeding:

```bash
# 1. Create the branch
/workspace/skills/github/gh.jsh branch create my-feature owner/repo

# 2. Push file changes to that branch
/workspace/skills/github/gh.jsh content put src/index.js ./index.js "Add entry point" --branch=my-feature owner/repo

# 3. Open the PR
/workspace/skills/github/gh.jsh pr create "My title" "PR body" my-feature owner/repo
# → note the returned PR number (e.g. 42)

# 4. Verify CI has started (wait for status to move past 'queued')
/workspace/skills/github/gh.jsh run list owner/repo

# 5. Once CI is green, merge
/workspace/skills/github/gh.jsh pr merge 42 --squash owner/repo
```

**Validation checkpoints:**
- After `branch create`: confirm no error output before pushing content.
- After `pr create`: capture the PR number for subsequent steps.
- After `run list`: check that all jobs show `✓` (success) before merging. If any show `✗` (failure), inspect with `run view <id>` before proceeding.

### Review and merge an existing PR

```bash
# Inspect the PR and its checks
/workspace/skills/github/gh.jsh pr view 42 owner/repo

# Confirm CI is passing
/workspace/skills/github/gh.jsh run list owner/repo

# Post a comment then merge
/workspace/skills/github/gh.jsh pr comment 42 "Automated: all checks passed, merging." owner/repo
/workspace/skills/github/gh.jsh pr merge 42 --squash owner/repo
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
