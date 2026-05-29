---
name: strava
description: >
  Interact with Strava — view your cycling, running, and fitness activities, check your activity feed,
  personal records (PRs), athlete profile, and notifications. Use when the user mentions Strava,
  cycling, running, activities, fitness tracking, segments, PRs, personal records, workout history,
  activity feed, athlete stats, Strava feed, Strava activities, Strava running, Strava cycling,
  Strava fitness, Strava notifications, training data, ride stats, run stats, elevation, pace,
  distance, duration, or wants to see their recent Strava workouts. Triggers on phrases like
  "show my Strava", "check my activities", "what did I ride", "my Strava feed", "show PRs",
  "personal records", "recent runs", "recent rides", "Strava notifications", "activity stats".
allowed-tools: bash
command: strava
script: scripts/strava.jsh
---

# Strava Skill

Read-only Strava client using browser session cookies from an open strava.com tab.

## Usage

```
strava me                    Show your athlete profile
strava feed [--limit N]      Show activity feed (default: 10 entries)
strava feed --mine           Show only your own activities
strava prs                   Show personal records
strava activity <id>         Show details for a specific activity
strava notifications         Show notification count
strava --help                Show help
```

## Requirements

You must have **strava.com open and logged in** in your browser. The skill uses your
browser session cookies automatically — no API keys needed.

## Flags

- `--limit N` — number of feed entries (default 10, max 50)
- `--mine` — filter feed to your own activities only
- `--json` — output raw JSON instead of formatted text
