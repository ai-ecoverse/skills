---
name: gmaps
description: >-
  Google Maps directions from the command line — travel time, distance and route
  options between two places for walking, public transit (lines, stops,
  departures, fares), cycling and driving (live traffic with typical range), for
  leaving now or at a given departure / arrival time. Calls the Maps web app's
  own directions backend directly: no API key, no login, no browser tab. Use when
  the user asks how far a place is, how long it takes to get somewhere, the way
  from A to B, which bus or train to take, when to leave to arrive on time, "is
  it walkable", or wants a Google Maps directions link. Triggers on "Google
  Maps", "gmaps", "directions", "how far is", "how long to get to", "route from …
  to …", "travel time", "when do I need to leave". Not place search or reviews,
  and not the paid Google Maps Platform API.
allowed-tools: bash
---

# gmaps

`gmaps` asks Google Maps for directions through the same backend endpoint the
Maps web app uses (`/maps/preview/directions`). It needs no API key, cookie or
browser tab, and answers all four travel modes in about 1.5 s. The command is [`scripts/gmaps.jsh`](scripts/gmaps.jsh);
offline tests live in `tests/gmaps.test.js` (`tst skills/gmaps/tests/gmaps.test.js`).

## Quick start

```bash
gmaps route "Levelingstraße 2, 81673 München" "August-Everding-Straße 24, 81671 München"
gmaps route "Marienplatz München" "Munich Airport" --mode transit --arrive 08:00
gmaps route "King's Cross, London" "Tower of London" --depart 2026-10-07T08:30 --json
gmaps link  "<from>" "<to>" --mode walking      # shareable URL only
```

Example output:

```
TRANSIT
  ★ 9 min · 1.8 km  19:02–19:11
      walk 1 min → Bus 190 19:03 from Schlüsselbergstraße → walk 2 min
      €4.20 · every 10 min
DRIVING
  ★ 6 min · 1.5 km  via Schlüsselbergstraße and Grafinger Str.  (typically 5–7 min)
```

`★` marks the route Google recommends. The output ends with an Open-in-Maps link
the user can tap on a phone.

## Options

| Option | Meaning |
| --- | --- |
| `--mode walking\|transit\|bicycling\|driving\|all` | Default `all` (fetched in parallel) |
| `--depart <t>` | Leave at `HH:MM` (today) or `YYYY-MM-DDTHH:MM` |
| `--arrive <t>` | Arrive by that time. Mutually exclusive with `--depart` |
| `--json` | Per mode: `{mode, from, to, routes[], error?, url, time?}` |

A route has `duration`/`seconds`, `distance`/`meters`, and then by mode: `via`
(walking, cycling, driving), `typical` (driving range), or `departs`,
`arrives`, `fare`, `headway` and `legs[]` (transit). Each transit leg has
`mode`, `line`, `headsign`, `from`, `to`, `departs`, `arrives` and `stops`.

Times you pass and times printed are **local to the trip** (London trips use
London time), as 24-hour clock. Exit codes: 0 if any mode returned routes, 1
if all failed, 2 for bad arguments.

## Workflow

1. Quote each place and include a city or postcode.
2. Read the resolved `from → to` header: Google fuzzy-matches, so a vague query
   can land on a different place (a café name may resolve to another café).
   Say what was matched if it differs from what the user meant.
3. `can't find "…"` means geocoding failed, so retry with a fuller address. `no
   <mode> route` means the places exist but are not connected (e.g. driving
   across an ocean).
4. For "when should I leave", use `--arrive` with transit and quote the latest
   departure.

## Caveats

- This endpoint is undocumented. If Google changes it, the script fails loudly
  ("response was not JSON" / "layout changed") instead of printing wrong
  numbers. The protocol, the minimal request and every response index are in
  [references/internals.md](references/internals.md).
- Driving times for a future `--depart` are Google's traffic prediction.
- Distances follow Google's locale for the region (km in Germany, miles in the UK).
