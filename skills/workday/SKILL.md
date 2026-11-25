---
name: workday
description: Workday org chart and people directory from the browser session — find
  colleagues by name, look up a person's title, email, location and manager, show
  someone's management chain, team and direct reports, and list the members of any
  supervisory organization. Use when the user asks who someone reports to, who is on a
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

Flags: `--json` on every command prints the parsed data. `--chain N` caps the
management chain of `orgchart`.

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
