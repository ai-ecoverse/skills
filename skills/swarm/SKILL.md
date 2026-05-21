---
name: swarm
description: CLI access to Foursquare/Swarm check-in history, venue visits, and location search via the Foursquare v2 API. Use when the user mentions Foursquare, Swarm, check-ins, venues, venue history, places visited, top venues, location search, or wants stats about where they've been. Supports paginated check-in lookups, category filtering, nearby venue search, full venue detail (rating, hours, personal visit count), and overall check-in statistics with top 5 most-visited venues.
allowed-tools: bash
---

# Swarm

Direct API access to Foursquare/Swarm check-in history via the v2 API
(`api.foursquare.com/v2/`). Auth is **page-context fetch** through
`playwright-cli eval`: the script finds an open `app.foursquare.com` browser
tab and issues `fetch(..., { credentials: 'include' })` from inside the page,
so the session cookies are sent automatically. No API token, no client
credentials, no separate config — zero-config as long as the Foursquare web
app is open in the browser.

If no `app.foursquare.com` tab is open, the command prints an error and
exits. Open <https://app.foursquare.com> in the browser, wait for the page to
load, then retry.

## Quick start

```bash
# Recent check-ins (default: latest 20)
swarm checkins

# Latest 10 check-ins
swarm checkins --limit=10

# Venue visit history sorted by visit count
swarm history

# Venues you've been to in a specific category
swarm history --category=4bf58dd8d48988d1d2941735

# Search for venues near a lat,lng
swarm search coffee --near=52.3906,13.0645

# Full detail for a single venue
swarm venue 4b5a0c05f964a5200a4f28e3

# Overall stats + top 5 most-visited venues
swarm stats
```

## Commands

All commands print colored, human-readable output to stdout.

### swarm checkins [--limit=N] [--offset=N] [--category=ID]

Recent check-ins from `/users/self/checkins`. Each entry shows venue name,
city, primary category, and check-in date.

- `--limit=<n>` — page size (default `20`, max `250`).
- `--offset=<n>` — pagination offset (default `0`).
- `--category=<id>` — filter by Foursquare category ID.

```bash
swarm checkins --limit=50 --offset=50
```

### swarm history [--category=ID]

Venue visit history from `/users/self/venuehistory`, sorted by visit count
(`beenHere`) descending. Useful for "where have I been most often".

- `--category=<id>` — filter by category ID.

```bash
swarm history --category=4bf58dd8d48988d16d941735   # cafés
```

### swarm search <query> --near=<lat,lng>

Search for venues near a location via `/venues/search`. `--near` is
**required** and takes a `lat,lng` pair. Returns up to 10 venues with name,
city, distance, category, and venue ID.

```bash
swarm search sushi --near=52.52,13.405
```

### swarm venue <venue-id>

Full detail for a single venue from `/venues/:id`: name, category, address,
rating, your personal check-in count (`beenHere`), website, and current
open/closed hours status.

```bash
swarm venue 4b5a0c05f964a5200a4f28e3
```

### swarm stats

Overall stats: total check-in count, unique venue count, and the top 5
most-visited venues. Combines `/users/self/checkins` (for total count) with
`/users/self/venuehistory` (for unique venues and top rankings).

```bash
swarm stats
```

## References

See [references/endpoints.md](references/endpoints.md) for per-endpoint
documentation: query parameters, response shapes, and common category IDs.
