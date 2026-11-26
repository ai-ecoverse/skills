---
name: workday
description: Workday org chart and people directory from the browser session — find
  colleagues by name, look up a person's title, email, location and manager, show
  someone's management chain, team and direct reports, list the members of any
  supervisory organization, resolve a list of names to ids in bulk (lookup), and walk a
  whole org below a manager (tree), with a per-tenant cache. Use when the user asks who someone reports to, who is on a
  team, who their colleagues or peers are, who leads an org, what someone's job title
  or email is, or wants to explore the Workday org chart without clicking through
  myworkday.com. Triggers on Workday, myworkday.com, org chart, organization chart,
  reporting line, management chain, manager, direct reports, skip-level, team members,
  colleagues, supervisory organization, "who is", "who reports to", "who does X work
  for". Read-only. Runs in SLICC, and on a host under jsh over Chrome DevTools (CDP).
allowed-tools: bash
---

# Workday

`workday` reads the org chart through the same backend that Workday's web client
calls (the `.htmld` UI endpoints on `<host>.myworkday.com`), from a signed-in Workday
tab. No API key or integration user: the tab's session does the work, so it can
see what the user can see in Workday, and nothing more. Every command is read-only.

## Quick start

```bash
workday whoami                       # you: name, title, manager, org path
workday find "Ada"                   # people matching a name, with their ids
workday person "Ada Lovelace"        # title, email, location, manager, org path
workday orgchart                     # your management chain, team and direct reports
workday orgchart "Grace Hopper"      # a manager: their chain, peers and reports
workday orgchart '247$1001' --chain 1
workday org '2500$2001'              # one supervisory organization and its members
printf 'Ada Lovelace\nAlan Turing\n' | workday lookup   # names → id, title, org, location, manager
workday tree "Charles Babbage"       # everyone below a manager, with their top-level group
workday tree '2500$2001' --depth 2 --json
workday cache                        # entries, size and path of the cache
```

Every listing prints `id:…` so that the next call can take an id instead of a name.
Workers are `247$…`, supervisory organizations `2500$…`. The `$` needs single
quotes in a shell.

A name that matches several people stops with the candidates and their ids
(`workday person Ada`). An exact full-name match wins over partial matches.

## Commands

| Command | Output |
| --- | --- |
| `whoami` | The signed-in user, their manager and org path |
| `find <name>` | Up to 10 people: name, title, org, location, id. Workday's own typeahead, so a first name, last name or prefix works; emails don't |
| `person [<name\|id>]` | Title, email, location, managers, org path (default: you) |
| `orgchart [<name\|id>]` | Management chain (nearest first), the team the person is on with the person marked `▸`, and their direct reports. A manager's peers are the other leads in their parent org |
| `org <2500$id>` | Owner, parent org and every member of one org; members that lead a team show its size |

| `lookup` | Bulk resolver. Names on stdin, one per line (or with `--json` an array of objects with a `name`; other fields pass through, the answer is added as `workday`). Per name: `status` (`found`, `ambiguous`, `not-found`, `no-profile`), id, title, org, location, manager. An exact full-name match wins; an ambiguous or missing name gets a status and never stops the run |
| `tree <name\|247$id\|2500$id>` | Every person below a person (the team they lead) or in an org, breadth-first, each once: id, name, title, location, `group` (the root's direct report whose sub-org holds them; a direct report heads their own group; the root's owner has none) and `depth`. Pages every org past its first page. `--depth N` expands N levels |
| `cache [info]`, `cache clear` | Entry count, size and path of the cache; empty it |

Flags: `--json` on every command prints the parsed data. `--chain N` caps the
management chain of `orgchart`. `--depth N` limits `tree`. Put flags after the
names; a flag can take the next word as its value.

## Cache and rate limit

Search results, worker profiles, team pages and the assembled member list of each
org are cached, one file per tenant: `~/.cache/workday/<host>_<tenant>.json`
(`$WORKDAY_CACHE_DIR` replaces the directory). Entries expire after 24 hours.

- `--max-age 1h` (also `90s`, `15m`, `2d`) changes how old an entry may be.
- `--fresh` ignores the cache for reading and refreshes it.
- `workday cache` shows entries, size and path; `workday cache clear` deletes the
  cache files of every tenant. `rm -r ~/.cache/workday` does the same.

Only parsed answers are stored: no cookies, tokens or headers, and never an error,
an XML error body, a sign-in page or a 401/403. The org chart's chunk URLs are
server-side cursors that go stale, so they are not stored; the finished member
list of the org is.

Workday limits bursts by answering HTTP 200 with "Too many repeating requests".
`workday` waits 15 s, then 30 s, then 60 s (`--retry-wait 5s` changes the first
wait) and tries at most 4 times, then stops with a message; what it already
fetched stays cached, so a rerun carries on. `lookup` and `tree` also wait
`--gap` (default 1 s) between requests; cached answers cost neither.

For a manager, Workday's *View Team* opens the team they lead, so `orgchart`
lists that team as direct reports and loads the parent org as their own team.

## Requires

- A Workday tab on `https://<host>.myworkday.com/<tenant>/…`, signed in. The tenant
  comes from that tab's URL; nothing about a tenant is hard-coded.
- In SLICC, the browser connected (`playwright-cli tab-list` answers).
- On a host: `npm install -g` this folder, and Chrome with a DevTools port. It is
  found automatically, or set `SLICC_CDP_URL`.

"session expired" or "returned a page instead of data" means the Workday sign-in
lapsed: sign in again in that tab and retry.

## How it works

See [references/endpoints.md](references/endpoints.md) for the requests, their
parameters and response shapes, and the pitfalls found while capturing them.
