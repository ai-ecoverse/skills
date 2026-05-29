---
name: garmin
description: >
  Interact with Garmin Connect — list Garmin activities, view Garmin fitness data, inspect Garmin
  health stats, browse Garmin devices, and manage your Garmin profile. Use this skill whenever the
  user mentions Garmin, Garmin Connect, Garmin activities, Garmin fitness tracking, Garmin health
  data, Garmin running, Garmin cycling, Garmin swimming, Garmin workouts, Garmin GPS watch,
  Garmin devices, Garmin Forerunner, Garmin Fenix, Garmin Vivoactive, activity history on Garmin,
  fitness stats from Garmin, heart rate from Garmin, steps from Garmin, or wants to query, list,
  or explore any data from connect.garmin.com. Activate on phrases like "my Garmin activities",
  "Garmin workout history", "list my runs on Garmin", "show my Garmin data", "Garmin fitness
  summary", "check my Garmin", "recent activities from Garmin", "my Garmin devices", or anything
  requesting Garmin health metrics, Garmin running stats, Garmin cycling data, Garmin step counts,
  Garmin heart rate zones, or Garmin device registration information.
allowed-tools: bash
---

# Garmin Connect Skill

Provides CLI access to Garmin Connect via the DI OAuth2 Bearer token flow against
`connectapi.garmin.com`. Bypasses the Cloudflare-protected `gc-api` endpoint entirely.

## Commands

```
garmin login                          # Authenticate via SSO intercept + ticket exchange
garmin activities [--limit N] [--start N] [--json]   # List recent Garmin activities
garmin activity <id>                  # Single Garmin activity detail
garmin devices                        # List registered Garmin devices
garmin profile                        # Show Garmin user profile
garmin --help                         # Show help
```

## Auth Flow

Run `garmin login` once. Tokens are stored in skill config and auto-refreshed:
- Access token: ~26 hours
- Refresh token: 30 days

If the refresh token expires, run `garmin login` again.

The login opens a browser tab via `oauth-token --intercept`. Sign in, and the ticket is
extracted from the redirect URL automatically.

## Implementation

All logic lives in `scripts/garmin.jsh`. Invoke via:

```bash
jsh /shared/skills/garmin/scripts/garmin.jsh <subcommand> [args]
```

Or register as a shell command: create an alias or wrapper that calls the above.
