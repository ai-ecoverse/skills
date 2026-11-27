---
name: workday
description: Workday org chart and people directory from the browser session. Find
  colleagues by name, look up a person's title, email, location and manager, show a
  management chain, team and direct reports, list a supervisory organization, resolve
  names to ids in bulk (lookup), walk a whole org below a manager (tree), with a
  per-tenant cache, and keep an idle signed-in Workday tab from being signed out
  (keepalive). Use when the user asks who someone reports to, who is on a team, who
  their peers are, who leads an org, what someone's title or email is, wants to explore
  the Workday org chart without clicking through myworkday.com, or keeps getting signed
  out of Workday when idle. Triggers on Workday, myworkday.com, org chart, reporting
  line, management chain, direct reports, skip-level, supervisory organization, "who
  reports to", "who does X work for", Workday session timeout, keep Workday alive.
  Reads only. Runs in SLICC, and on a host under jsh over Chrome DevTools (CDP).
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
workday keepalive --once             # touch the session once (cron); keepalive alone loops
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
| `keepalive` | Touch the session every few minutes so Workday doesn't sign the tab out for being idle. See below |
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

## Keepalive

`workday keepalive` keeps a signed-in Workday tab from being signed out for being
idle. It sends what Workday's own "your session is about to expire" prompt sends
when you press its reset button: `GET /<tenant>/ping.htmld`, with the session token
from `home.htmld` in a `Session-Secure-Token` header. The answer is
`<nyw:Keepalive_Response nyw:Session_Timeout_Minutes="30"/>`.

```bash
workday keepalive                 # loop; interval = a third of the idle timeout (10m for 30)
workday keepalive --every 10m     # your own interval
workday keepalive --once          # one touch, for cron
workday keepalive --count 3       # three touches, then exit
```

One line per touch: `09:00:00 OK (idle timeout 30m), next in 10m`. Exit 0 when
every touch worked; a bounded run (`--once`, `--count N`) with any failed touch
exits 1 when it ends. It exits 1, saying so, as soon as the session is gone (sign-in
page, 401/403, or an XML error); three failed touches in a row (HTTP 5xx, an
unknown answer) also stop it, and a rate-limit answer uses the same 15 s, 30 s, 60 s
retry as every other command.

What it is not: it only extends an idle session that you already signed in to. It never
signs in, fills a form or clicks, it can't get around SSO, and Workday's absolute
session limit still applies: when that ends, sign in again by hand. Requests are
same-origin reads made by the CLI (`sliccy:browser` fetch); nothing is injected into
the tab. Don't try to do this with a timer in the page: Chrome throttles timers in
hidden tabs.

### Keeping it going in SLICC

A cron job running `--once` is the robust choice: each run is a short, separate
process, it survives a reload of SLICC, and a failure shows in the log. Every 10
minutes, inside working hours:

```bash
(crontab -l 2>/dev/null; printf '%s\n' '# name: workday-keepalive' '*/10 8-18 * * mon-fri  workday keepalive --once') | crontab -
```

`crontab -` replaces the whole table, so this keeps the lines already there. Its output is in `/var/log/cron/<user>/workday-keepalive.log`. Keep the interval at or below a third of the
idle timeout your tenant reports (`workday keepalive --once` prints it; 10 minutes fits 30). When it
exits 1 the log says "session is gone": sign in again and the next run carries on.

Alternatively run the loop as a background job (`workday keepalive --every 10m >
/tmp/workday-keepalive.log 2>&1 &`). It stops at the first lost session and is gone
after a reload of SLICC, so prefer cron for anything that should last.

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
