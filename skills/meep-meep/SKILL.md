---
name: meep-meep
description: >
  Drive a web page one typed action at a time with `webrunner`, a Jev-style
  browser loop whose only model call is one choice over concrete actions.
  Use when a goal must be carried out in a browser tab step by step: fill a
  search form, pick an autocomplete suggestion, click through to a result,
  or run the link, search, and Google Flights demos. The local `kev` model
  (decide-quickly) decides on device, loaded once per run; Bedrock is the
  fallback decider. The model never writes a selector, a coordinate, or
  JavaScript: it picks one ref that playwright-cli snapshot printed.
allowed-tools: bash
---

# meep-meep

`webrunner` opens a page and repeats: snapshot, decide, act, snapshot again.

```bash
webrunner demo link
webrunner demo search
webrunner demo flights
webrunner run --url https://example.com --goal 'Enter "Ada Lovelace" in Name, then press Save.' --expect Saved
```

## One step

1. `playwright-cli snapshot` lists the page. Every textbox, searchbox, combobox, and clickable control with a ref becomes a candidate.
2. The runner builds one menu: `type "<value>" into <field>` for each field and each value in the goal, the 16 highest-ranked clicks, and `wait`. Clicks rank higher when they sit in a `search`, `form`, or dialog landmark, when they are new since the last step (an autocomplete list), and when they share words with the goal. Banner and footer controls and long promo labels rank lower.
3. kev answers one choice question over that menu. Its state is the goal, the actions already taken, and the offered controls with their current values. Loading kev-9b takes about 30 s once. A step takes 0.5–7 s, depending on menu size.
4. `playwright-cli click` or `fill` applies the chosen ref. Refs are dead after the action, so the next step starts with a new snapshot.

## Values to type

kev never invents text. The values it can type come from the goal: each `"quoted string"` is one value, and each capitalised name is another (`Berlin`, `London`). Quote dates and multi-word values: `Type "Sep 30" into Departure`. With `--decider bedrock`, a second call returns only `{"text": "..."}` for the chosen field.

## When it stops

- **Passed:** the `--expect` text is on the page and the address contains `--expect-url`. With either flag set, `done` is not offered, so the model cannot pass itself.
- **Without a check:** `done` is offered. It passes only when a yes/no question on a new snapshot agrees.
- **Stuck:** three actions in a row leave the page unchanged, or the step cap (`--max-steps`, default 8) runs out.

## Watching a run

The shell prints stdout and stderr only when the command exits. While it runs, read `/tmp/meep/webrunner.log`. `/tmp/meep/step-<n>.txt` holds the exact state and menu kev saw at step n, which is the first thing to read when a step goes wrong.

## Known page quirks

- Google labels its inputs `"Where from? "` with a trailing space. playwright-cli then cannot map the ref to a node, so the runner focuses the control by its trimmed name and types real keystrokes (`playwright-cli type`), which still opens the suggestion list.
- Google Flights opens a date picker instead of searching when no dates are set, so the flights demo goal names both dates.
- A consent wall ("Before you continue") is dismissed with its own `Reject all` ref before the loop starts.

## Setup

The first kev run installs the kev.js bundle and onnxruntime-web with `kev prepare`, then restarts itself once. The demos use weights mounted at `/mnt/kev/kev-9b` when present. Otherwise the weights are downloaded (8.8 GB for 9b). Bedrock reads `BEDROCK_CAMP_API_KEY` and `BEDROCK_REGION` from `/mnt/secrets/bedrock.env`.
