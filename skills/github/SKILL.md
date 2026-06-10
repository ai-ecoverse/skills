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

A few SLICC-specific quirks that bite when you go beyond `gh.jsh` and reach for raw `git` or `curl`.

### `git clone` aborts on directory bundles (`.graffle`, `.app`, `.framework`)

The OPFS-backed git in SLICC fails mid-checkout when a tracked directory whose name has a dotted suffix has child entries — it tries to `mkdir` the children before the parent dir is fully realised. Cloning `adobe/helix-home` reproducibly aborts on `docs/helix2/observation/Observation.graffle/` with:

```
git: ENOENT: ENOENT: No such file or directory, mkdir
'.../helix-home/docs/helix2/observation/Observation.graffle' …
```

The wrapper also rejects flag-based workarounds: `git clone --depth=1`, `--single-branch`, and `--filter=…` all error with `Cannot parse remote URL: --depth`. And once a checkout aborts, the OPFS node can be left in a "phantom" state — `ls` won't show it, but `mkdir` rejects with `File exists`. `rm -rf` and re-mkdir don't recover; the only fix is to clone into a fresh path.

**Workaround: `init` + `fetch` + sparse-checkout to skip the bad directory:**

```bash
mkdir -p /workspace/clones/myrepo
cd /workspace/clones/myrepo

git init
git remote add origin "https://$(oauth-token github)@github.com/owner/repo.git"
git fetch origin

# Tell git to skip the path that triggers the OPFS mkdir bug:
git config core.sparseCheckout true
mkdir -p .git/info
cat > .git/info/sparse-checkout <<SPARSE
/*
!/path/to/Bad.graffle/
SPARSE

# Materialise the working tree:
git checkout --force <branch>
```

`git checkout --force` will print `There are multiple errors that were thrown by the method` — those are the suppressed errors for the excluded paths. Checkout actually succeeds. Verify with `ls` and `git ls-files | wc -l`.

After this, `git status` may report the excluded files as "Changes to be committed" because the index treats them as deletions — sparse-checkout isn't fully wired in this git wrapper. Don't `git commit -a` from this tree blindly; stage explicitly with `git add <specific-paths>` or restore with `git checkout HEAD -- <excluded-path>`.

### Missing git subcommands

The SLICC `git` wrapper supports the verbs listed in `git --help`. Anything else fails with `'<cmd>' is not a git command`. Notably absent:

- `git update-ref` — you can't manually move a branch ref
- `git read-tree` — can't populate the index from a tree without a checkout
- `git restore` — use `git checkout -- <path>` instead
- `git worktree` — single working tree only

For ref manipulation, fall back to the GitHub Git Data API (`gh.jsh api /repos/owner/repo/git/refs -X POST …`).

### `curl --data @file` silently corrupts the body for GitHub API uploads

For any file containing non-ASCII bytes (or arbitrarily, sometimes for ASCII-only files too), `curl --data @<path>` and `curl --data-binary @<path>` produce a body that GitHub rejects with:

```json
{ "message": "Problems parsing JSON", "status": "400" }
```

Inline `-d '{"…":"…"}'` works fine for short payloads, and stdin pipe (`echo … | curl -d @-`) sometimes works for short payloads, but neither is reliable for longer JSON.

**Workaround: build and POST entirely from `node`:**

```bash
cat > /tmp/post-issue.mjs <<NODE
const body = await fs.readFile('/tmp/issue-body.md', 'utf8');
const tok = process.env.GH_TOK;
const r = await fetch('https://api.github.com/repos/owner/repo/issues', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + tok,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json'
  },
  body: JSON.stringify({ title: 'My issue', body })
});
console.log(r.status, await r.text());
NODE
GH_TOK="$(oauth-token github)" node /tmp/post-issue.mjs
```

The `gh.jsh api` passthrough avoids this entirely — it builds the body from `-f key=value` flags or stdin, never from `@file`. Prefer it whenever possible.

### Uploading binary or non-ASCII content via the Contents API

`PUT /repos/owner/repo/contents/<path>` requires a base64-encoded `content` field. The naïve approach — `fs.readFile(path, 'utf8')` then `btoa(text)` — produces a **double-encoded** result for any file with non-ASCII bytes. The SLICC node realm's `fs.readFile(path, 'utf8')` does not actually UTF-8-decode the bytes; it returns a JS string where each input byte is a single codepoint. `TextEncoder().encode()` then re-UTF-8-encodes those codepoints, so an em-dash (`e2 80 94` on disk) becomes `c3 a2 c2 80 c2 94` in the upload payload, and GitHub stores those exact corrupted bytes. The file looks fine when read back via the same broken pipeline, but is mojibake to anyone using a different tool.

**Use `fs.readFileBinary` instead** — it returns a `Uint8Array` with the actual on-disk bytes:

```javascript
const arr = await fs.readFileBinary('/tmp/file.md');
// Convert Uint8Array → "binary string" → base64 (this round-trip is byte-faithful):
let bin = '';
for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
const b64 = btoa(bin);

// PUT to the contents API:
const r = await fetch(`https://api.github.com/repos/owner/repo/contents/${path}`, {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'commit msg', content: b64, sha: existingSha, branch })
});
```

Verify after upload by fetching `https://raw.githubusercontent.com/owner/repo/<branch>/<path>` from a browser tab via `playwright-cli eval`, **not** from `curl | xxd` — the SLICC shell's I/O layer also applies a Latin-1↔UTF-8 round-trip, so a correctly-stored file will *look* corrupted in `cat` / `xxd` / `head -c`.

### Creating symlinks via the Contents API

`PUT /repos/owner/repo/contents/<path>` always creates a regular file (mode `100644`). It cannot create a symlink. To add a symlink (e.g. `tiles/basic/skills/<name> → ../../../skills/<name>` in `ai-ecoverse/skills`), use the Git Data API:

```bash
TOK=$(oauth-token github)

# 1. Get current branch HEAD and tree
HEAD=$(gh.jsh api /repos/owner/repo/git/ref/heads/<branch> --jq .object.sha)
TREE=$(gh.jsh api /repos/owner/repo/git/commits/$HEAD --jq .tree.sha)

# 2. Create a blob with the symlink target (just the target path text)
BLOB=$(gh.jsh api /repos/owner/repo/git/blobs -X POST \
  -f content="../../../skills/myskill" -f encoding=utf-8 --jq .sha)

# 3. Build a new tree on top of the current tree, with mode 120000 (symlink)
NEW_TREE=$(gh.jsh api /repos/owner/repo/git/trees -X POST \
  -f base_tree=$TREE \
  -f tree[0][path]="tiles/basic/skills/myskill" \
  -f tree[0][mode]=120000 \
  -f tree[0][type]=blob \
  -f tree[0][sha]=$BLOB \
  --jq .sha)

# 4. Commit and move the ref
COMMIT=$(gh.jsh api /repos/owner/repo/git/commits -X POST \
  -f message="add tiles/basic/skills/myskill symlink" \
  -f tree=$NEW_TREE -f parents[]=$HEAD --jq .sha)
gh.jsh api /repos/owner/repo/git/refs/heads/<branch> -X PATCH -f sha=$COMMIT
```

Mode `120000` is the magic number for symlinks in the Git tree object. The blob content is the literal target path string, no special encoding.

### Race conditions on long-running operations

`oauth-token github` and `gh.jsh` calls are quick, but a long sequence of git fetches or contents-API writes can occasionally appear to "stall" — the SLICC bash session enforces some implicit timeouts. If a `git fetch origin` hangs at "Resolving deltas" for >30 seconds and stops emitting progress, give it another 60 seconds before assuming it's stuck. Killing and retrying often resumes from the partial pack.

