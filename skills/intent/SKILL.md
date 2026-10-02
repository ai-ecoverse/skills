---
name: intent
description: >
  Drive a browser tab one stated intent at a time with `intent`, a
  playwright-cli overlay that returns a small result instead of a page
  snapshot. Each call says what you want in words — open a URL, click the
  Search button, fill the name field with "Ada Lovelace", select "Medium"
  from the size dropdown, check the terms box, press Enter, scroll down,
  close the cookie banner, what is the total price, is the cart empty, wait
  until the results load — and a local decision model (kev) finds the
  control or the text and acts or answers. Use instead of playwright-cli
  snapshots when page context is expensive: filling forms, searching a
  site, reading a value off a page, checking a result, clicking through
  results, playing a browser game step by step. When it is not sure it does
  nothing and lists the candidates with refs, so you can say more or name a
  ref. `--full` prints the snapshot when you really need it.
allowed-tools: bash
---

# intent

`intent` turns one sentence into one browser step and answers in a few lines. You decide what to do next; `intent` only finds the control or the text your sentence means.

```bash
intent prepare                                   # once: the kev runtime
intent pull --model 4b-vision                    # once: 5.4 GB of weights (resumes)
intent --intent "open https://httpbin.org/forms/post"
intent --intent 'fill the customer name with "Ada Lovelace"'
intent --intent "choose the Medium pizza size"
intent --intent "press the Submit order button"
intent --intent "what customer name did the server receive?"
```

A call without `--tab` uses the tab of the last call. Opening a URL without a tab opens one.

## Kinds of intent

The kind is read from the words. `--kind` overrides it.

| Kind | Say | Returns |
| --- | --- | --- |
| NAVIGATE | `open <url>`, `go back`, `reload` | the address, title, and a page gist: headings, fields, buttons with refs |
| ACT | `click …`, `type "x" into …`, `select "x" from …`, `check …`, `press Enter`, `scroll down`, `close the banner` | `✓` what was done and what changed: address, field values, checked states, new controls with refs |
| RETRIEVE | `what is …?`, `read the error message` | the text that answers it (cut around your words), its ref and heading |
| VERIFY | `is the cart empty?`, `verify the order was placed` | `yes` or `no` with p, and the evidence text |
| WAIT_FOR | `wait until the results load` | when it held (`--timeout S`, default 15) |

Quote text to type and options to select: `type "Sep 30" into Departure`. Unquoted works for the usual phrasings ("fill the name field with Ada Lovelace", "set quantity to 3").

When System 1 is not sure, nothing happens. The answer starts with `?` and lists the candidates, each with its ref and probability. Say more (the label or the row: "the comments link of the second story"), or pass `--ref e41` from the list. `--candidates N` lists without acting, and `--dry-run` says which control an ACT would use.

## How it decides

1. **Classify** the intent by its words.
2. **Filter.** Every control (or text segment) on the page is ranked by the intent's words: idf-weighted overlap with labels and row context, a bonus for a whole label, ordinals ("the first", "the top story" pick the 1st of a series like "165 comments", "21 comments", …), and a penalty for header and footer chrome. Typing ranks only fields. Text is cut into segments: the largest row, paragraph or list item under 400 characters, so "Born | April 28, 1906" stays together. Checked, selected and expanded states come from an in-page scan, because the snapshot does not print them (ai-ecoverse/slicc#3766).
3. **Choose.** The top 24 controls (16 texts) go to System 1 as one choice question with a NONE option. A -vision bundle also sees the screenshot, each candidate boxed and labelled with its ref. VERIFY and WAIT_FOR ask a yes/no question over the top 6 segments.
4. **Act or answer** when the top choice reaches the model's threshold (`--sure` overrides it); otherwise return the candidates.

Enter is pressed in the page: slicc's `press Enter` sends no key code, so forms do not submit (ai-ecoverse/slicc#3765).

## System 1

`--model` picks it. The local kev bundles are the default; Clef runs on Cloudflare Workers AI and needs the `CLOUDFLARE_API_TOKEN` secret (domain api.cloudflare.com) and `--cf-account <id>` once (remembered).

RESULTS_TABLE

`--from <dir>` loads any kev bundle directory, such as a fine-tune (`--from /mnt/kev-models/kev-0.8b-vision-wr1`). A missing model stops with the command that gets it; nothing falls back to a guess.

Each call loads the model again. For many calls in a row, keep it loaded: run `intent serve` where it may stay, and `intent` hands its requests to it.

## intent serve

`intent serve` keeps System 1 loaded and takes requests from `/tmp/intent/q`. An `intent` call finds it by its heartbeat (`/tmp/intent/serve.json`) and waits for the answer in `/tmp/intent/a`.

**This deliberately widens what an intent-only agent can do.** A scoop allowed only `intent` may not run playwright-cli: a scoop's grant also binds the commands an allowed `.jsh` runs. The server runs outside the scoop and drives the browser for it. A request is therefore intent fields only (intent, kind, ref, tab, sure, candidates, dry-run, full, timeout, json, model). Each field is checked strictly: refs and tabs by pattern, numbers by range, unknown fields refused. A request is never an argv, a URL to fetch, or a shell string. Run a server only while such a scoop works, as the eval arm does.

`jshd` units have no browser in slicc, so the server runs in a shell, not as a jshd unit.

## Evals

`evals/harness` runs meep-meep's goals (the default suite and the games) through tools/harness-evals with three Sonnet 5.5 arms:
- `intent-agent`: a scoop that may run only `intent`, served by `intent-arm`;
- `playwright-scoop`: the same scoop with raw playwright-cli;
- `playwright-agent`: the cone with playwright-cli.

`intent-arm` records the tool calls, the characters each call put into context, the scoop's tokens and cost (`agent --usage`), and each intent call's latency. Its files are in `/tmp/intent-arm/<run>/`.

The snapshot parser, page scan and kev loader are copies of meep-meep's and decide-quickly's (ai-ecoverse/skills#423). Deduplicate them once #423 lands.
