---
name: github
description: >
  Interact with GitHub via gh.jsh — a lightweight GitHub CLI for SLICC agents.
  Use this skill for any GitHub task: listing or viewing pull requests, merging PRs,
  posting comments, checking out branches, viewing issues, inspecting workflow runs,
  listing releases, searching PRs, or managing Actions variables. Trigger on requests
  like "list open PRs", "check CI status", "merge this PR", "what issues are open",
  "show the latest release", "post a comment on PR #42", "set a repo variable",
  or any task involving a GitHub repository.
allowed_tools:
  - bash
---

# gh — GitHub CLI for SLICC Agents

`gh.jsh` is a Node.js GitHub CLI that wraps the GitHub REST API with clean formatted output, ANSI color, and sensible defaults. No `curl | jq` pipelines.

## Setup

**Authentication** — store your PAT in git config:
```bash
git config github.token <YOUR_PAT>
```
Or set `GITHUB_TOKEN` as an environment variable. The token is read automatically on every invocation.

**Repo defaults** — if you omit `owner/repo`, the script infers it from the current directory's `git remote get-url origin`. Pass it explicitly to override.

## Running the script

```bash
/workspace/skills/github/gh.jsh <command> <subcommand> [args]
```

All commands follow the pattern: `gh.jsh <noun> <verb> [positional args] [owner/repo]`

---

## Command Reference

### Pull Requests

**List open PRs**
```bash
gh.jsh pr list
gh.jsh pr list owner/repo
```
Output: number, title, branch, state (with `[DRAFT]` tag if applicable)

**View a PR**
```bash
gh.jsh pr view 42
gh.jsh pr view 42 owner/repo
```
Shows title, author, branch, URL, check summary (passed/failed/pending), and body preview (first 400 chars).

**Merge a PR**
```bash
gh.jsh pr merge 42                        # default: merge commit
gh.jsh pr merge 42 --squash
gh.jsh pr merge 42 --rebase
gh.jsh pr merge 42 --squash owner/repo
```

**Post a comment**
```bash
gh.jsh pr comment 42 "LGTM, merging now"
gh.jsh pr comment 42 "Please rebase" owner/repo
```

**Checkout commands**
```bash
gh.jsh pr checkout 42
```
Prints the `git fetch` and `git checkout` commands to check out the PR branch. Does not execute them (VFS-safe).

---

### Issues

**List open issues**
```bash
gh.jsh issue list
gh.jsh issue list owner/repo
```
Output: number, title, labels

**View an issue**
```bash
gh.jsh issue view 123
gh.jsh issue view 123 owner/repo
```
Shows title, author, URL, labels, body preview.

---

### Repository

**View repo info**
```bash
gh.jsh repo view
gh.jsh repo view owner/repo
```
Shows description, stars, forks, default branch, language, topics, last push, URL.

---

### Workflow Runs

**List recent runs**
```bash
gh.jsh run list
gh.jsh run list owner/repo
```
Output: run ID, workflow name, status/conclusion, branch, date

**View a run**
```bash
gh.jsh run view 12345678
gh.jsh run view 12345678 owner/repo
```
Shows run details, commit, and per-job status with duration.

---

### Releases

**List recent releases**
```bash
gh.jsh release list
gh.jsh release list owner/repo
```
Output: tag, name, published date. Pre-release and draft tags shown inline.

---

### Search

**Search PRs**
```bash
gh.jsh search prs "fix login"
gh.jsh search prs "fix login" owner/repo
```
Uses GitHub search API. Returns PR number, title, repo, and state.

---

### Actions Variables

**List variables**
```bash
gh.jsh vars list
gh.jsh vars list owner/repo
```

**Set a variable**
```bash
gh.jsh vars set MY_VAR "hello world"
gh.jsh vars set MY_VAR "hello world" owner/repo
```
Creates or updates the variable (PATCH if exists, POST if new).

---

## Output Format

Columns are aligned with fixed widths. ANSI color coding:

| Color  | Meaning                          |
|--------|----------------------------------|
| Green  | success / open / merged          |
| Red    | failure / closed                 |
| Yellow | pending / in_progress / draft    |
| Gray   | skipped / cancelled / metadata   |
| Cyan   | IDs, variable names, PR numbers  |

Status symbols:
- `✓` success / open / merged (green)
- `✗` failure / closed (red)
- `●` pending / in_progress (yellow)
- `○` skipped / cancelled / draft (gray)

---

## Error Handling

API errors print to stderr and exit 1:
```
gh: pr list failed: HTTP 404: Not Found
```

Missing required arguments exit with a usage hint.

---

## Examples for Agents

```bash
# Check what PRs are waiting for review
/workspace/skills/github/gh.jsh pr list ai-ecoverse/slicc

# Inspect a specific PR before merging
/workspace/skills/github/gh.jsh pr view 42 ai-ecoverse/slicc

# Merge after review
/workspace/skills/github/gh.jsh pr merge 42 --squash ai-ecoverse/slicc

# Post a status comment
/workspace/skills/github/gh.jsh pr comment 42 "Automated: all checks passed, merging." ai-ecoverse/slicc

# Check CI for a repo
/workspace/skills/github/gh.jsh run list ai-ecoverse/slicc

# Diagnose a failed run
/workspace/skills/github/gh.jsh run view 14567890123 ai-ecoverse/slicc

# Find PRs related to a feature
/workspace/skills/github/gh.jsh search prs "auth token" ai-ecoverse/slicc
```
