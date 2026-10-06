---
name: intent
description: >
  Drives a browser tab one stated intent at a time with `intent`, a
  playwright-cli overlay that answers in a few lines instead of a page
  snapshot. Each call says in words what to do: open a URL, click the
  Search button, fill the name field with "Ada Lovelace", select "Medium"
  from the size dropdown, check the terms box, press Enter, scroll down,
  close the cookie banner, read the total price, check whether the cart is
  empty, wait until the results load, list the links about pricing. A local
  decision model (kev) finds the control or text and acts or answers; when
  unsure it does nothing and lists candidates with refs. Use for browser
  automation where snapshots are expensive: navigating a website, filling
  out and submitting web forms, automating a login or checkout, searching
  a site, clicking through results, reading or scraping data off a web
  page, verifying a page state, playing a browser game step by step.
  Prefer it over raw playwright-cli snapshots; `--full` still prints one.
allowed-tools: bash
---

# intent

`intent` turns one sentence into one browser step and answers in a few lines. The caller decides what to do next; `intent` only finds the control or the text the sentence means.

## Setup

1. `intent prepare` installs the kev runtime (once per machine).
2. `intent pull --model 4b-vision` downloads the default System 1 (5.4 GB; it resumes). `intent pull` with no flag does the same.
3. Optional, for many calls in a row: `intent serve` in a shell that may stay open keeps the model loaded; every `intent` call is then handed to it.
4. Check: `intent --intent "open https://example.com"`, then `intent --intent "what is the main heading?"` answers `"Example Domain"`. A missing runtime or model stops with the command that fixes it.

## Quick start

```bash
intent --intent "open https://httpbin.org/forms/post"
intent --intent 'fill the customer name with "Ada Lovelace"'
intent --intent "choose the Medium pizza size"
intent --intent "press the Submit order button"
intent --intent "what customer name did the server receive?"
```

A call without `--tab` uses the tab of the last call. Opening a URL without a tab opens one. `intent --help` lists every flag, including `--json` and `--retrieve budget` (a RETRIEVE returns the most likely texts up to a character budget instead of one answer).

## Kinds of intent

The kind is read from the words; `--kind` overrides it.

| Kind | Say | Returns |
| --- | --- | --- |
| NAVIGATE | `open <url>`, `go back`, `reload` | the address, title, and a page gist: headings, fields, buttons with refs |
| ACT | `click …`, `type "x" into …`, `select "x" from …`, `check …`, `press Enter`, `scroll down`, `close the banner` | `✓` what was done and what changed: address, field values, checked states, new controls with refs |
| RETRIEVE | `what is …?`, `read the error message` | the text that answers it, its ref and heading; when no single text is sure, the closest few in page order |
| RETRIEVE (list) | `list the links about drugs`, `list the rows that mention calories`, `list the buttons`, `what is the URL of the Sivana link?` | up to 20 matching links (with URLs), buttons, fields or rows with refs, in page order; matched by words, no model |
| VERIFY | `is the cart empty?`, `verify the order was placed` | `yes` or `no` with its probability, and the evidence text |
| WAIT_FOR | `wait until the results load` | when it held (`--timeout S`, default 15) |

A field shows what the page says about it besides its name: placeholder, type (email, tel, time, multi-line), required, invalid. A click that opens a new tab says so, and the next calls use that tab.

## Writing intents

An intent that names its control acts at once; a vague one comes back as `?` with candidates and costs a second call.

- Name the control by the words on it, quoted when it has several: `click "Buy and Eat"`, not "buy the food".
- Say which one when a label repeats: its row (`the "BUY" button in the Cocaine row`) or its place (`the first result`, `the top story's comments link`).
- One action per call; text to type in quotes: `type "Ada Lovelace" into the customer name field`.
- To find one control among many, `list the links about …`; to read several values, `list the rows that mention …`; for one value, ask a question.

## When it is not sure

When System 1 is not sure of an ACT, nothing happens. The answer starts with `?` and lists the candidates, each with its ref and probability:

1. Pass the right ref: `intent --intent "click Search" --ref e41`. Rewording costs another model call.
2. Or say more: the label, the row, the place.
3. `--candidates N` lists without acting; `--dry-run` says which control an ACT would use.
4. `--full` prints the whole snapshot when nothing else helps.

A ref from an earlier result or from `--full` stays usable after the page re-renders: it is found again by role, label and order. A `--ref` whose control plainly is not what the intent names (another control matches the words, this one none of them) is refused rather than acted on.

## playwright-cli through intent

Any playwright-cli command runs through intent as it is, with its intent stated: `intent screenshot --tab=ID --filename=page.png --intent "see the result list"`, `intent eval "document.title" --tab=ID --intent "read the title"`. Without `--intent` it is refused. The output is playwright-cli's own; the tab it names or opens becomes the tab of the next intent call.

## System 1

`--model` picks it: `4b-vision` (default), `0.8b-vision` (1 GB, faster, less accurate), `4b`, `0.8b`, or `clef` / `clef-flash` on Cloudflare Workers AI (needs the `CLOUDFLARE_API_TOKEN` secret for api.cloudflare.com and `--cf-account <id>` once). `--from <dir or URL>` loads any kev bundle, such as a fine-tune; `intent pull --from <URL>` fetches it ahead. `--sure P` overrides the act-or-ask threshold. A missing model stops with the command that gets it; nothing falls back to a guess. Accuracy, thresholds and how the pipeline was chosen: [references/system1.md](references/system1.md).

## intent serve

`intent serve` keeps System 1 loaded; every `intent` call is then handed to it (`--local` skips it). It also does the browser work for any scoop allowed only `intent`: stop it when no such scoop should browse. What it accepts and the eval driver: [references/evals.md](references/evals.md).
