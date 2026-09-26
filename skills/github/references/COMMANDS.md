# `gh` command reference

Every command accepts the upstream GitHub CLI flag form **and** this CLI's original positional
form. `-R owner/repo` / `--repo owner/repo` works wherever a trailing `[repo]` positional does
(passing both is an error). `--help` works on every command and subcommand:

```bash
gh --help
gh pr --help
gh pr create --help
gh help pr create
gh version
```

`--help` wins over everything, even after boolean flags — `gh pr merge 42 --squash --help`
prints help instead of merging. The terse `-h`/`-?` counts as help while still in the leading
command words, and always on a state-changing command; pass a literal `-h` after `--`
(`gh vars set FOO -- -h`). `--help` and `gh version` / `--version` work without a GitHub token.

## `--json` / `--jq`

Available on: `pr view`, `pr list`, `pr edit`, `pr checks`, `issue view`, `issue list`, `run list`,
`run view`, `repo view`, `release list`, `vars list`, `notifications list`, `search prs`,
`search issues`, `project list`, `project list-items`, `monitor list`. `dashboard update` and
`dashboard show` take a bare `--json` (the stored entry, no field selection).

```bash
gh pr view 123 --json statusCheckRollup,reviews,comments,mergeable
gh pr view 123 --json state,mergeable --jq '.mergeable'
gh run view 456 --json jobs --jq '.jobs[]|select(.conclusion=="failure")|.name'
gh pr list --json number,title,headRefName --state all --limit 5
gh pr view 123 --json                      # every field
```

- Bare `--json` emits all fields; an unknown field errors with the list of valid ones.
- Field names match case- and shape-insensitively (`statusCheckRollup` == `status_check_rollup`).
- `--jq`/`-q` uses the real `jq` when present, with a built-in `.a.b` / `.a[].b` fallback.

Field sets (see `gh <cmd> <sub> --help` for the authoritative list):

| Command | Fields |
|---|---|
| `pr list` | `number title body state isDraft author headRefName baseRefName headRefOid url createdAt updatedAt closedAt mergedAt labels assignees reviewRequests milestone id` |
| `pr edit` | same as `pr list` (the updated PR) |
| `pr view` | all of `pr list` plus `merged mergeable mergeStateStatus mergeCommit additions deletions changedFiles commits commitsCount statusCheckRollup reviews reviewDecision comments` |
| `pr checks` | `name state bucket status conclusion link workflow startedAt completedAt description` |
| `issue list` | `number title body state stateReason author url createdAt updatedAt closedAt labels assignees milestone commentsCount id` |
| `issue view` | all of `issue list` plus `comments` (the comment array) |
| `run list` | `databaseId number name displayTitle status conclusion event headBranch headSha workflowName workflowDatabaseId url createdAt updatedAt startedAt attempt` |
| `run view` | all of `run list` plus `jobs` (each with `steps`) |
| `repo view` | `name nameWithOwner owner description url sshUrl defaultBranchRef isPrivate isFork isArchived stargazerCount forkCount openIssuesCount primaryLanguage licenseInfo repositoryTopics visibility createdAt updatedAt pushedAt homepageUrl hasIssuesEnabled id` |
| `search prs` | `number title body state author repository url createdAt updatedAt closedAt labels isDraft commentsCount id` |
| `search issues` | `number title body state author repository url createdAt updatedAt closedAt labels commentsCount id` |
| `release list` | `name tagName isDraft isPrerelease isLatest publishedAt createdAt url body author id` |

- `pr view --json commits` is an **array of commit objects** (`oid`, `messageHeadline`,
  `messageBody`, `authoredDate`, `committedDate`, `authors`, `url`) — upstream's shape, so
  `--jq '.commits[].oid'` works. The REST integer count is `commitsCount`. The commit list is
  only fetched when the field is requested.
- `release list --json isLatest` marks exactly one entry — the repository's actual latest
  release (`/releases/latest`), not "every stable release".

## Pull requests

```bash
gh pr list                                  # --state open|closed|merged|all --limit N --base B --head H --draft --json
gh pr view 42                               # --json --jq --comments
gh pr diff 42                               # unified diff of the files changed in the PR
gh pr checks 42                             # per-check status/conclusion for the head commit; --json
gh pr create --title "T" --body "B" --head my-branch
gh pr create --title "T" --body-file ./body.md --head br --base develop --draft
gh pr create --title "T" --body "B" --head br --label bug --assignee me --reviewer someone
gh pr create "T" "B" my-branch --base=develop owner/repo     # positional form
gh pr edit 42 --title "New title" --body-file ./body.md --base develop
gh pr edit 42 --add-label ready --remove-label needs-info --add-assignee octocat
gh pr edit 42 --add-reviewer octocat --add-reviewer acme/platform --milestone v2.0
gh pr edit 42 --title "New title" --json number,title,url
gh pr merge 42 --squash --delete-branch      # or --merge (default) / --rebase; --subject --body --body-file
gh pr close 42 --comment "superseded by #43" # --delete-branch
gh pr comment 42 --body "LGTM"               # or: gh pr comment 42 "LGTM"; --body-file
gh pr checkout 42                            # prints git fetch/checkout commands, does not execute
gh pr watch 42                               # PR-scoped; --filter <js> adds a predicate; --scoop <name>
gh pr unwatch 42
gh pr ready 42                               # mark draft PR ready for review (GraphQL mutation)
gh pr ready 42 --undo                        # convert back to draft
```

- `pr create`: `--head` is the branch to merge from; `--base` defaults to the repo's default
  branch. `--label`/`--assignee` are applied after creation via the issues endpoint and
  `--reviewer` via the requested-reviewers endpoint; if a follow-up is refused the PR still
  exists and a warning is printed.
- `pr edit` selects a pull request by positive integer number. It accepts `-R`/`--repo`,
  `-t`/`--title`, `-b`/`--body`, `-F`/`--body-file`, `-B`/`--base`,
  `-m`/`--milestone`, `--remove-milestone`, `--add-label`, `--remove-label`,
  `--add-assignee`, `--remove-assignee`, `--add-reviewer`, and `--remove-reviewer`.
  `--body-file -` reads the body from stdin; other body files are sent verbatim, including any
  trailing newline. Add/remove flags are repeatable and comma-separated
  values also work; assignee flags accept `@me` for the authenticated user. Reviewer teams use
  `org/team`. `--body` conflicts with `--body-file`; `--milestone` conflicts with
  `--remove-milestone`; at least one edit flag is required. `--json [fields]` returns the updated
  PR, while unknown flags are rejected before mutation. No project flags or implicit, branch,
  or URL selectors are supported.
- `pr checks` reports check-runs **and** commit statuses, bucketed `pass`/`fail`/`pending`/`skipping`.
  Commit statuses are read from the combined-status endpoint, so a context that first reported
  `failure` and later `success` counts once, as its current state.
  `--watch` prints the table and then installs the event-driven watch (it does not poll, and it
  mutates the repo exactly as `pr watch` does).
- `pr checks` **exit status** follows upstream, so `gh pr checks 42 && gh pr merge 42` is safe:

  | Exit | Meaning |
  |---|---|
  | `0` | every check passed (or was skipped/neutral) |
  | `1` | at least one check failed — or no checks were reported at all |
  | `8` | nothing failed, some checks still queued/in progress |

  `--watch` exits `0` once the watch is installed; the outcome then arrives as licks.

- `pr diff` prints a unified diff reconstructed from
  `GET /repos/{owner}/{repo}/pulls/{n}/files` (filename + patch per file). `--repo` /
  `-R` and a trailing `owner/repo` work as elsewhere. A missing PR exits 1 with a
  clear error and no stdout.
- `pr ready` uses the GraphQL `markPullRequestReadyForReview` mutation (the REST API has no
  draft toggle). `--undo` calls `convertPullRequestToDraft`. No-ops when the PR is already in
  the target state.

## Issues

```bash
gh issue list                                # --state --limit --label --assignee --author --milestone --search --json
gh issue view 123                            # --json --jq --comments
gh issue create --title "T" --body "B" --label bug --assignee me
gh issue create "T" "B" --labels=bug,triage  # positional form
gh issue edit 123 --add-label triage --remove-label needs-info
gh issue edit 123 --title "New" --body-file ./body.md --state closed
gh issue comment 123 --body "on it"
gh issue close 123 --reason not_planned --comment "won't fix"
```

`issue edit` replaces the label set with `--label`, or adjusts it incrementally with
`--add-label`/`--remove-label` (likewise `--add-assignee`/`--remove-assignee`).

`--milestone` takes a milestone **title** (`--milestone v1.0`, as upstream documents) or its
number; a title is resolved to the number the REST API requires, and an unknown title errors
with the list of available milestones. On `issue list`, `*` (any milestone) and `none` also work.

`issue list --search` (also `-S`) maps onto `GET /search/issues` with `repo:` and `type:issue`
qualifiers, plus `--state` / `--label` / `--assignee` / `--author` / `--milestone` when set.
It is not a silent no-op on the unfiltered list.

## Workflow runs

```bash
gh run list                                  # --branch --workflow --event --status --user --limit --json
gh run view 12345678                         # --json --jq
gh run view 12345678 --log-failed            # logs for the failed jobs (the usual next step on red CI)
gh run view 12345678 --log --log-tail 0      # every job, whole log
gh run view 12345678 --log-failed --job build
```

Logs come from the Actions logs API. The excerpt shown is the window ending at the last
`##[error]` annotation (a raw tail usually lands in post-job cleanup), sized by `--log-tail`
(default 200 lines, `0` = the whole log). If the download is refused, each step's name and
conclusion is printed instead. `run view` also lists failed steps inline in its plain output.

## Repository, branches, file content

```bash
gh repo view                                 # --json --jq
gh repo archive owner/repo                   # irreversible without admin unarchive
gh repo clone owner/repo [dir]               # --depth N, -b/--branch B, -- <git flags>
gh branch create my-feature --from develop   # or --from=<sha>
gh branch delete my-feature
gh content put README.md ./local.md "Update README" --branch my-feature
```

`content put` reads a local VFS file, base64-encodes it and creates or updates it via the
Contents API, handling the SHA lookup for existing files.

`repo clone` shells out to `git clone` with the public HTTPS URL; ambient credentials provide
auth without embedding a token in the URL. For forks, an `upstream` remote is added
automatically. Errors on non-empty destinations or inaccessible repos.

## Releases, search, Actions variables

```bash
gh release list                              # --limit --json
gh search prs "fix login"                    # --limit --state --json; -R owner/repo
gh search issues "fix login"                 # --limit --state --json; -R owner/repo
gh vars list                                 # --json
gh vars set MY_VAR "hello world"             # PATCH if it exists, POST if new
```

## Notifications

```bash
gh notifications list                        # --all/-a --participating/-p -n N (or -nN) --json
gh notifications read                        # -R owner/repo to scope to one repo
gh monday --limit 50 --date 7d               # Monday-protocol inbox as JSON
```

## Projects (org-owned, v2)

Org-scoped: pass an org login, never `owner/repo`. Requires the `project` scope.

```bash
gh project list myorg                        # or --owner myorg; --json
gh project list-items myorg 2                # --json
gh project add-draft myorg 2 "Some request" "Longer body"
gh project add-draft myorg 2 --title "Some request" --body "Longer body"
gh project set-title myorg 2 215884384 "New title"
```

`add-draft` creates a draft issue — an item that lives only inside the project with no linked
repository until someone converts it in GitHub's UI. `set-title` looks up the item's own title
field ID for you (project field updates are field-ID-based, not `{title: ...}`).

## Dashboard monitoring (`monitor`)

Owns `/shared/github-monitor/config.json`, the list of repositories the github-dashboard
sprinkle fetches. Not a GitHub API surface — the only API call is the one `add` makes to prove
the repository exists and is reachable with your token.

```bash
gh monitor list                                  # --json [slug,bbProject,source], --jq
gh monitor add octocat/Hello-World               # resolves the bb project from `bb project list`
gh monitor add some/repo --bb-project proj_xxxxxxxxxx
gh monitor add some/repo --no-bb-project         # record null as a deliberate decision
gh monitor rm octocat/Hello-World
```

Schema (v1, owned by these verbs, validated by the fetcher):

```json
{ "version": 1,
  "bbOrigin": "https://bb.example.invalid",
  "repos": [ { "slug": "owner/repo", "bbProject": "proj_xxx" } ] }
```

`repos` is an array so `add` appends, `rm` filters and `list` prints in order, and an object
entry leaves room for future per-repo fields without a migration (unknown fields are preserved
verbatim across edits). `slug` is the identity; a duplicate is an error, not a dedupe.
**`bbProject` must be present and may be `null`** — bb thread state is not on GitHub and that id
is its only source, so `add` is required to decide rather than leave it out.

bb project resolution order, and why it is not just the name:

| Tier | Signal | Notes |
|---|---|---|
| 1 | `gitRemoteUrl` of a bb project matches `owner/repo` | Handles `https://` and `git@host:` forms; the project's name is irrelevant |
| 2 | bb project **named** exactly the repo part of the slug | Fallback only — used when no project declares the repo as a remote |
| — | 0 candidates, or >1 in either tier | **Error.** `--bb-project <id>` or `--no-bb-project` |

A name-only match cannot be trusted on its own: a bb project named `skills` can be
`octocat/skills` while `other/skills` belongs to the project named `other-skills`, and two
distinct projects can share one git remote. An explicit `--bb-project` is verified against
`bb project list` and a nonexistent id is rejected.

Exit codes: `1` for anything the caller can fix (bad slug, duplicate, 404, unresolved bb
project, unknown flag, removing the last repo); `2` when the **existing** config is malformed,
matching the fetcher's own code for that case — it refuses to edit a file it cannot parse rather
than overwrite whatever is in there.

Writes are atomic: the new content is serialised once, validated as bytes, staged as a sibling
`config.json.tmp-*`, read back and re-validated, then renamed over the target. Any failure
leaves the original byte-identical and removes the temp file.

`rm` does **not** prune the repo's entries from the dashboard's `data/user-state.json` or
`data/status-cache.json`; they are keyed `owner/repo#number`, so leaving them makes
remove-then-re-add lossless and they are inert while the repo is unmonitored.

Environment overrides, for testing only:

| Variable | Effect |
|---|---|
| `GH_MONITOR_CONFIG=<path>` | Redirect the family at a scratch config. The fetcher always reads the real path, so this only moves `gh monitor`. |
| `GH_MONITOR_FAULT=corrupt-temp` | Truncate the staged temp file, so the round-trip check rejects it |
| `GH_MONITOR_FAULT=throw-before-rename` | Fail between staging and rename |

Acceptance test for anything this writes:

```bash
node /shared/sprinkles/github-dashboard/fetch-snapshot.mjs --check-config   # exit 0 = accepted
```

## Dashboard agent reports (`dashboard`)

Owns the github-dashboard sprinkle's `data/reports.json`
(default `/shared/sprinkles/github-dashboard/data/reports.json`): what an agent working an
item reports about it. Local only: no GitHub call, and no token needed.

```bash
gh dashboard update <owner/repo#N> [--status working|needs-attention|done|clear]
    [--thread <bb-thread-url|scoop-name>] [--pr <ref>] [--note <text>] [--file <path>] [--json]
gh dashboard show [<owner/repo#N>] [--json] [--file <path>]
gh dashboard clear <owner/repo#N> [--file <path>]
```

| Flag | Accepts | Stored as |
|---|---|---|
| key | `owner/repo#N` only. Anything else is a usage error (exit 1). | the entry's key |
| `--status` | `working`, `needs-attention`, `done`; `clear` deletes the entry and cannot be combined with other fields | `"status"` |
| `--thread` | a URL whose path has a `thr_[a-z0-9]+` segment, e.g. `https://bb.example.invalid/projects/proj_example01/threads/thr_example01` | `{"kind":"bb","id","url"}` |
|  | a scoop name: letters, digits, `-`, `_`, no scheme, no slash | `{"kind":"scoop","name"}` |
|  | a bare `thr_…` is **rejected**: pass the thread URL, because the id does not say which bb host it is on | — |
| `--pr` | `N`, `#N` (both in the key's repo), `owner/repo#N`, `https://github.com/owner/repo/pull/N` | `"owner/repo#N"` |
| `--note` | any text | `"note"` |

At least one of `--status`, `--thread`, `--pr`, `--note` is required. Updates **merge**:
the flags given overwrite their fields, and the other fields, including unknown ones, are
kept. Every update sets `at` (ISO) and appends a compact entry to `history` (the fields it
set, with `thread` as `bb:<id>`/`scoop:<name>` and `note` cut to 120 characters), which
keeps the last 20. `update` prints one line with what is now recorded; `--json` prints the
stored entry. `show` without a key lists every report (`--json`: the `reports` object); with
a key it prints that report and its history, and a missing key is exit 1. Clearing an entry
that is not there is a no-op (exit 0) that writes nothing.

File format:

```json
{ "version": 1,
  "reports": {
    "owner/repo#N": { "status": "working", "thread": { "kind": "scoop", "name": "my-scoop" },
                      "pr": "owner/repo#M", "note": "…", "at": "2026-…Z", "history": [ … ] } } }
```

Writes use the async (live) fs. The new file is staged as a sibling `reports.json.tmp-*` and
read back. The target is then re-read, and the temp is renamed over it only if the target is
still the version the update merged into. Otherwise the temp is dropped and the update is
merged into the newer version, up to 5 attempts. Any failure removes the temp and leaves the
file byte-identical. A file that does not parse, or is not `version: 1` with a `reports`
object, is refused with exit 2. A missing data directory is an error: the command does not
create directories. The full format is in the github-dashboard skill's
`references/reports.md`.

## Raw API passthrough

```bash
gh api /repos/owner/repo
gh api /repos/owner/repo -i                    # include response status and headers
gh api /repos/owner/repo/git/ref/heads/main --jq .object.sha
gh api /repos/owner/repo/git/refs -X POST -f ref=refs/heads/new-branch -f sha=abc123
```

`-i`/`--include` prints the response status and headers before the body. `-X`/`--method`,
`-f`/`--raw-field key=value` (raw strings), `-F`/`--field key=value`
(typed values; `@file` and `@-` read UTF-8 or stdin), `--input <file>` (send a JSON file as
the request body; use `-` for stdin; mutually exclusive with `-f`/`-F`),
`--jq`/`-q`. Fields and `--input` imply POST unless `-X` is explicit; use `-f key=@mention`
for a literal leading `@`. Unknown flags are rejected. See [`gotchas.md`](gotchas.md).

## Auth

```bash
gh auth        # token source, authenticated user, AI-attribution status
```

## MCP server passthrough

```bash
gh mcp tools                                        # list available MCP tools
gh mcp call <tool> [-F key=value]... [-f key=value]  # invoke a tool
gh mcp server-card                                  # show the server card
gh mcp raw <method> [--init] [--params JSON]        # raw JSON-RPC
```

Requires a separate `GITHUB_MCP_TOKEN` or `git config gh-mcp-token` — the managed
token is domain-locked to `api.github.com`. See [`mcp.md`](mcp.md) for full reference.
