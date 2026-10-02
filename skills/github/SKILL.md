---
name: github
description: >
  Interact with GitHub via gh.jsh, a GitHub CLI for SLICC agents that accepts both the real
  GitHub CLI's syntax (--title/--body, -R owner/repo, --json [fields], --jq, --help) and its
  own positional forms.
  Use for any GitHub task: listing, viewing, diffing, editing or merging pull requests and
  marking them ready for review, checking CI and failed job logs, commenting on or searching
  PRs and issues, viewing issues, workflow runs, releases, Actions variables, creating or
  checking out branches, pushing file content, archiving/cloning repos, org-owned Projects
  (v2), choosing which repos the github-dashboard sprinkle monitors, recording an agent's
  status report on a dashboard item, or calling any GitHub API endpoint.
  Trigger on "list open PRs", "show the PR diff", "why did CI fail", "merge this PR",
  "has this been filed", "show the latest release", "set a repo variable",
  "monitor this repo on the dashboard", "which repos are we monitoring",
  "report status to the dashboard".
allowed_tools:
  - bash
---

# gh — GitHub CLI for SLICC agents

`gh` wraps the GitHub REST API with formatted output, `--json` machine output, and sensible
defaults. No `curl | jq` pipelines.

Run `gh --help`, `gh <command> --help` or `gh <command> <subcommand> --help` — every command
is self-documenting, and help plus `gh version` work without a GitHub token. Full reference:
[`references/COMMANDS.md`](references/COMMANDS.md).

## Authentication

```bash
oauth-token github                                 # default scopes (repo, read:org)
git config github.token "$(oauth-token github)"    # persists for gh and git push/pull
```

Precedence: `skill.token('github')` → `git config github.token` → `$GITHUB_TOKEN`.
Check with `gh auth`. Extra scopes when needed: `workflow` (editing `.github/workflows/`),
`delete_repo`, `admin:org`, `project` (all `project` subcommands):

```bash
git config github.token "$(oauth-token github --scope workflow)"
```

## Syntax

Both syntaxes work for every command — the upstream flag form and this CLI's positional form:

```bash
gh pr create --title "T" --body "B" --head my-branch --base main -R owner/repo
gh pr create "T" "B" my-branch --base=main owner/repo
```

| Situation | Behaviour |
|---|---|
| Flag and positional both usable | The flag wins |
| Same value twice (`-R owner/repo` **and** trailing `owner/repo`) | Error, never a silent pick |
| Unrecognised flag | Warned on stderr and passed through as a positional; `pr edit` rejects it before mutation |
| `--` | Ends flag parsing |

Repo defaults to the current git remote `origin`; override with `-R owner/repo` or the
trailing positional. `--json [fields]` (+ `--jq`/`-q`) is available on the read commands and
`pr edit`; bare `--json` emits all fields, unknown fields error with the valid list.

## Workflows

### Open a PR

```bash
gh branch create my-feature owner/repo
gh content put src/index.js ./index.js "Add entry point" --branch my-feature -R owner/repo
gh pr create --title "My title" --body "PR body" --head my-feature -R owner/repo
```

`pr create` prints the new PR number — capture it and reuse that exact number below.

### Read a PR diff

```bash
gh pr diff <num> -R owner/repo
```

Prints a unified diff of the files the PR changes. A missing PR exits 1 with a clear error
and empty stdout. Use this before merge, and when checking a diff for accidentally-committed
secrets.

### Search issues (including duplicate-check)

```bash
gh search issues "playwright upload binary" -R owner/repo
gh issue list --search "playwright upload binary" -R owner/repo
```

`search issues` queries GitHub issue search. `issue list --search` maps onto the same API
instead of returning an unfiltered list.

### Edit a PR

```bash
gh pr edit <num> --title "New title" --body-file ./body.md --base main -R owner/repo
gh pr edit <num> --add-label ready --remove-assignee old-user -R owner/repo
gh pr edit <num> --add-reviewer user --add-reviewer org/team --milestone v2.0 -R owner/repo
gh pr edit <num> --title "New title" --json number,title,url -R owner/repo
```

`pr edit` requires a numeric PR number and at least one edit flag. It supports title,
body/body-file, base, milestone changes, and additive/removal label, assignee, and reviewer
updates; body files are sent verbatim, including a trailing newline. `--json [fields]` returns
the updated PR, and unknown flags are rejected before mutation. See the command reference for
the exact flag list. Project flags and implicit, branch, or URL selectors are not supported.

### Check CI, and diagnose it when red

```bash
gh pr checks <num> -R owner/repo                     # per-check status
gh pr view <num> --json statusCheckRollup,mergeable  # machine-readable
gh run list -R owner/repo                            # find the run id
gh run view <run_id> --log-failed -R owner/repo      # the failing job's log
```

`gh pr checks` exits `0` when everything passed, `1` on failure (or no checks at all) and
`8` while checks are still running — so the merge can be gated on it:

```bash
gh pr checks <num> -R owner/repo && gh pr merge <num> --squash --delete-branch -R owner/repo
```

### Stay in the loop on a PR without polling

```bash
gh pr watch <num>      # PR/review/CI events arrive as licks (idempotent)
gh pr unwatch <num>    # tear down when the PR reaches a terminal state
gh pr ready <num>      # mark a draft PR ready for review; --undo reverts to draft
```

`pr watch` installs a webhook, so it mutates the repo. Events are filtered to the target PR
before they reach the scoop; `--filter <js>` adds a second predicate that must also pass.
A scoop reacting to those licks must
re-check live state first — see
[`references/webhook-pr-monitoring.md`](references/webhook-pr-monitoring.md) for the
self-echo-detection pattern and the stop condition.

### Choose which repos the dashboard monitors

```bash
gh monitor list                                   # --json [slug,bbProject,source]
gh monitor add octocat/Hello-World                # resolves the bb project itself
gh monitor add some/repo --bb-project proj_xxxxxxxxxx
gh monitor add some/repo --no-bb-project         # "this repo has no bb project", on purpose
gh monitor rm octocat/Hello-World
```

These own `/shared/github-monitor/config.json`, which the github-dashboard sprinkle's fetcher
reads to decide what to watch. The fetcher validates that file and **exits 2 without fetching**
if it is malformed, so `gh monitor` writes it atomically (staged sibling file → read back →
re-validated → renamed) and refuses to produce anything the fetcher would reject. Verify with
the fetcher itself:

```bash
node /shared/sprinkles/github-dashboard/fetch-snapshot.mjs --check-config   # exit 0 = accepted
```

**`bbProject` is required and may be `null` — `add` will not guess.** bb thread state is not on
GitHub, and that id is its only source, so a repo added without one produces dashboard cards
that can never link to a thread and look perfectly fine while doing it. `add` resolves the id
from `bb project list` by matching the project's **git remote** first and its **name** only as a
fallback (a name match alone is unsafe: a bb project named `skills` can belong to `octocat/skills`
while `other/skills` is the project named `other-skills`). If nothing resolves, or more than one
project matches, it is an **error** telling you to pass `--bb-project` or `--no-bb-project` —
never a silent `null`.

| Situation | Exit | Behaviour |
|---|---|---|
| Repo already monitored | 1 | Error, not a silent dedupe — a duplicate means the command lost track |
| Repo 404s | 1 | Names both causes: no such repo, **or** private and this token cannot see it |
| bb project unresolved / ambiguous / bad id | 1 | Error naming the consequence; nothing written |
| Existing config malformed | 2 | Same code the fetcher uses; refuses to edit rather than overwrite |
| `rm` of the last remaining repo | 1 | The fetcher rejects an empty `repos`; nothing is written |
| Config file absent | — | `add` creates it with that repo and the placeholder `bbOrigin` `https://bb.example.invalid`, and says to edit the origin; the shipped fetcher has no built-in repos to seed |

`rm` deliberately leaves that repo's rows in the dashboard's `data/user-state.json` and
`data/status-cache.json`. They are keyed `owner/repo#number`, so keeping them makes
remove-then-re-add lossless (read/pinned state and cached status survive) and they are inert
meanwhile, because nothing looks them up. The config edit itself is byte-stable too: one line
per repo entry, unknown top-level and per-repo fields preserved, so `add` then `rm` restores the
file exactly.

Testing override: `GH_MONITOR_CONFIG=/tmp/x.json` points the family at a scratch config (the
fetcher always reads the real path). `GH_MONITOR_FAULT=corrupt-temp|throw-before-rename` injects
a mid-write failure to demonstrate that a failed write leaves the original untouched.

### Report what an agent is doing on a dashboard item

```bash
gh dashboard update octocat/Hello-World#42 --status working --thread my-scoop
gh dashboard update octocat/Hello-World#42 --pr 57 --note "fix pushed"   # merges; status kept
gh dashboard show [octocat/Hello-World#42] [--json]
gh dashboard clear octocat/Hello-World#42
```

These write the github-dashboard's `data/reports.json`, locally and without a GitHub token.
`--thread` takes a bb thread **URL** or a scoop name, never a bare `thr_` id. `--pr` takes `N`,
`#N`, `owner/repo#N` or a PR URL. Test with `--file /tmp/…`. Flags and format:
[`references/COMMANDS.md`](references/COMMANDS.md#dashboard-agent-reports-dashboard).

## Mutating and destructive operations

`pr edit`, `pr merge`, `pr close`, `pr ready`, `issue close`, `branch delete`, `repo archive`,
`content put`, `vars set` and `pr watch`/`pr unwatch` change remote state. Before running one, confirm the
target with its read counterpart (`gh pr view <num>`, `gh pr checks <num>`,
`gh branch`/`gh repo view`) — and never act on a PR number you have not just read back.
`monitor add`/`monitor rm` change no remote state, but they do change what the dashboard
watches: confirm with `gh monitor list` first.

## MCP server passthrough

`gh mcp` is an authenticated passthrough to GitHub's remote MCP server at
`api.githubcopilot.com/mcp/`. It exposes Copilot-specific tools (e.g.
`assign_copilot_to_issue`, `request_copilot_review`, `create_pull_request_with_copilot`)
that have no REST API equivalent.

```bash
gh mcp tools                                        # list available MCP tools
gh mcp call get_me                                  # invoke a tool
gh mcp call get_file_contents -F owner=octocat -F repo=Hello-World -F path=README.md
gh mcp server-card                                  # show the MCP server card
gh mcp raw tools/list --init                        # raw JSON-RPC escape hatch
```

**Auth:** the managed `skill.token('github')` is domain-locked to `api.github.com` and
cannot reach `api.githubcopilot.com`. Provide a PAT separately:

```bash
export GITHUB_MCP_TOKEN="ghp_…"
# or persistently:
git config gh-mcp-token "ghp_…"
```

See [`references/mcp.md`](references/mcp.md) for the full subcommand reference.

## References

- [`references/COMMANDS.md`](references/COMMANDS.md) — every command, flag and `--json` field
- [`references/webhook-pr-monitoring.md`](references/webhook-pr-monitoring.md) — event-driven PR watching
- [`references/gotchas.md`](references/gotchas.md) — SLICC quirks when bypassing `gh` for raw `git`/`curl`

| Symptom | Quick fix |
|---|---|
| `git clone` aborts with `ENOENT mkdir <Foo.graffle>` | `git init` + `git fetch` + sparse-checkout excluding the path |
| `git clone --depth=1` rejects the flag | Use `init` + `fetch` |
| `curl --data @file` → `400 Problems parsing JSON` | Use `gh api --input file.json`, `-f key=value`, or `fetch()` from node |
| Uploaded files arrive as mojibake | Use `fs.readFileBinary` before `btoa` |
| Need to commit a symlink | Git Data API with `mode: 120000` |
