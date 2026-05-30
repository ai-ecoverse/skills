---
name: garmin
description: >
  Interact with Garmin Connect — list activities, view fitness data, inspect health stats,
  browse devices, and check your profile. Use when the user mentions Garmin, Garmin Connect,
  activities, fitness tracking, health data, running, cycling, swimming, workouts, GPS watch,
  devices, activity history, fitness stats, heart rate, steps, or wants to query data from
  connect.garmin.com. Triggers on phrases like "my Garmin activities", "workout history",
  "list my runs", "show my Garmin data", "fitness summary", "check my Garmin", "recent
  activities", "my Garmin devices", or anything requesting health metrics, running stats,
  cycling data, step counts, heart rate zones, or device information.
allowed-tools: bash
command: garmin
script: scripts/garmin.jsh
---

# Garmin Connect Skill

CLI access to Garmin Connect via the DI OAuth2 Bearer token flow against
`connectapi.garmin.com`. Bypasses the Cloudflare-protected `gc-api` endpoint entirely.

## Usage

```
garmin login                                         Authenticate via SSO intercept
garmin activities [--limit N] [--start N] [--json]   List recent activities
garmin activity <id> [--json]                        Single activity detail
garmin devices [--json]                              List registered devices
garmin profile [--json]                              Show user profile
garmin --help                                        Show help
```

## Requirements

Run `garmin login` once. A browser tab opens for Garmin SSO — sign in, and the
session ticket is captured automatically. Tokens are stored in skill config and
auto-refreshed:

- Access token: ~26 hours
- Refresh token: 30 days

If the refresh token expires, run `garmin login` again.

## Auth Flow

1. `garmin login` opens Garmin SSO via `oauth-token --intercept`
2. User signs in → redirect captured with `?ticket=ST-...`
3. Ticket exchanged for Bearer token at `diauth.garmin.com/di-oauth2-service/oauth/token`
4. Token stored; API calls go directly to `connectapi.garmin.com` (no Cloudflare)

## Flags

- `--limit N` — number of activities to fetch (default 20)
- `--start N` — pagination offset (default 0)
- `--json` — output raw JSON instead of formatted text
