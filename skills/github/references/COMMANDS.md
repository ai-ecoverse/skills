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
(`gh vars set FOO -- -h`).

## `--json` / `--jq`

Available on: `pr view`, `pr list`, `pr checks`, `issue view`, `issue list`, `run list`,
`run view`, `repo view`, `release list`, `vars list`, `notifications list`, `search prs`,
`project list`, `project list-items`.

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
| `pr view` | all of `pr list` plus `merged mergeable mergeStateStatus mergeCommit additions deletions changedFiles commits commitsCount statusCheckRollup reviews reviewDecision comments` |
| `pr checks` | `name state bucket status conclusion link workflow startedAt completedAt description` |
| `issue list` | `number title body state stateReason author url createdAt updatedAt closedAt labels assignees milestone commentsCount id` |
| `issue view` | all of `issue list` plus `comments` (the comment array) |
| `run list` | `databaseId number name displayTitle status conclusion event headBranch headSha workflowName workflowDatabaseId url createdAt updatedAt startedAt attempt` |
| `run view` | all of `run list` plus `jobs` (each with `steps`) |
| `repo view` | `name nameWithOwner owner description url sshUrl defaultBranchRef isPrivate isFork isArchived stargazerCount forkCount openIssuesCount primaryLanguage licenseInfo repositoryTopics visibility createdAt updatedAt pushedAt homepageUrl hasIssuesEnabled id` |
| `search prs` | `number title body state author repository url createdAt updatedAt closedAt labels isDraft commentsCount id` |
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
gh pr checks 42                             # per-check status/conclusion for the head commit; --json
gh pr create --title "T" --body "B" --head my-branch
gh pr create --title "T" --body-file ./body.md --head br --base develop --draft
gh pr create --title "T" --body "B" --head br --label bug --assignee me --reviewer someone
gh pr create "T" "B" my-branch --base=develop owner/repo     # positional form
gh pr merge 42 --squash --delete-branch      # or --merge (default) / --rebase; --subject --body --body-file
gh pr close 42 --comment "superseded by #43" # --delete-branch
gh pr comment 42 --body "LGTM"               # or: gh pr comment 42 "LGTM"; --body-file
gh pr checkout 42                            # prints git fetch/checkout commands, does not execute
gh pr watch 42                               # PR-scoped; --filter <js> adds a predicate; --scoop <name>
gh pr unwatch 42
```

- `pr create`: `--head` is the branch to merge from; `--base` defaults to the repo's default
  branch. `--label`/`--assignee` are applied after creation via the issues endpoint and
  `--reviewer` via the requested-reviewers endpoint; if a follow-up is refused the PR still
  exists and a warning is printed.
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

## Issues

```bash
gh issue list                                # --state --limit --label --assignee --author --milestone --json
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
gh branch create my-feature --from develop   # or --from=<sha>
gh branch delete my-feature
gh content put README.md ./local.md "Update README" --branch my-feature
```

`content put` reads a local VFS file, base64-encodes it and creates or updates it via the
Contents API, handling the SHA lookup for existing files.

## Releases, search, Actions variables

```bash
gh release list                              # --limit --json
gh search prs "fix login"                    # --limit --state --json; -R owner/repo
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

## Raw API passthrough

```bash
gh api /repos/owner/repo
gh api /repos/owner/repo/git/ref/heads/main --jq .object.sha
gh api /repos/owner/repo/git/refs -X POST -f ref=refs/heads/new-branch -f sha=abc123
```

`-X`/`--method`, `-f`/`--field key=value` (JSON body on non-GET), `--jq`/`-q`. Bodies are built
from `-f` flags, never from `@file` — see [`gotchas.md`](gotchas.md).

## Auth

```bash
gh auth        # token source, authenticated user, AI-attribution status
```
