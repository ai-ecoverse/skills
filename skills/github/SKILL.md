---
name: github
description: >
  Interact with GitHub via gh.jsh — a GitHub CLI for SLICC agents that accepts the real
  GitHub CLI's syntax (--title/--body, -R owner/repo, --json [fields], --jq, --help on every
  command) as well as its own positional forms.
  Use this skill for any GitHub task: listing or viewing pull requests, checking CI checks and
  failed job logs, merging PRs, posting comments, checking out branches, viewing issues,
  inspecting workflow runs, listing releases, searching PRs, managing Actions variables,
  creating branches, pushing file content, archiving repos, managing org-owned Projects (v2),
  or calling any GitHub API endpoint directly.
  Trigger on requests like "list open PRs", "check CI status", "why did CI fail", "merge this
  PR", "what issues are open", "show the latest release", "post a comment on PR #42",
  "set a repo variable", "create a branch", "push this file", "list my GitHub projects".
allowed_tools:
  - bash
---

# gh — GitHub CLI for SLICC agents

`gh` wraps the GitHub REST API with formatted output, `--json` machine output, and sensible
defaults. No `curl | jq` pipelines.

Run `gh --help`, `gh <command> --help` or `gh <command> <subcommand> --help` — every command
is self-documenting. Full reference: [`references/COMMANDS.md`](references/COMMANDS.md).

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
| Unrecognised flag | Warned on stderr, passed through as a positional |
| `--` | Ends flag parsing |

Repo defaults to the current git remote `origin`; override with `-R owner/repo` or the
trailing positional. `--json [fields]` (+ `--jq`/`-q`) is available on the read commands;
bare `--json` emits all fields, unknown fields error with the valid list.

## Workflows

### Open a PR

```bash
gh branch create my-feature owner/repo
gh content put src/index.js ./index.js "Add entry point" --branch my-feature -R owner/repo
gh pr create --title "My title" --body "PR body" --head my-feature -R owner/repo
```

`pr create` prints the new PR number — capture it and reuse that exact number below.

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
```

`pr watch` installs a webhook, so it mutates the repo. Events are filtered to the target PR
before they reach the scoop; `--filter <js>` adds a second predicate that must also pass.
A scoop reacting to those licks must
re-check live state first — see
[`references/webhook-pr-monitoring.md`](references/webhook-pr-monitoring.md) for the
self-echo-detection pattern and the stop condition.

## Destructive operations

`pr merge`, `pr close`, `issue close`, `branch delete`, `repo archive`, `content put`,
`vars set` and `pr watch`/`pr unwatch` change remote state. Before running one, confirm the
target with its read counterpart (`gh pr view <num>`, `gh pr checks <num>`,
`gh branch`/`gh repo view`) — and never act on a PR number you have not just read back.

## References

- [`references/COMMANDS.md`](references/COMMANDS.md) — every command, flag and `--json` field
- [`references/webhook-pr-monitoring.md`](references/webhook-pr-monitoring.md) — event-driven PR watching
- [`references/gotchas.md`](references/gotchas.md) — SLICC quirks when bypassing `gh` for raw `git`/`curl`

| Symptom | Quick fix |
|---|---|
| `git clone` aborts with `ENOENT mkdir <Foo.graffle>` | `git init` + `git fetch` + sparse-checkout excluding the path |
| `git clone --depth=1` rejects the flag | Use `init` + `fetch` |
| `curl --data @file` → `400 Problems parsing JSON` | Use `gh api -f key=value`, or `fetch()` from node |
| Uploaded files arrive as mojibake | Use `fs.readFileBinary` before `btoa` |
| Need to commit a symlink | Git Data API with `mode: 120000` |
