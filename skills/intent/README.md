# intent

A playwright-cli overlay for agents that browse: each browser call states its intent in words, and a local decision model (kev, "System 1") finds the control or the text and acts or answers in a few lines. The agent pays for its own reasoning, not for reading page snapshots.

```bash
intent --intent "open https://httpbin.org/forms/post"
intent --intent 'fill the customer name with "Ada Lovelace"'   # ✓ typed … [e2]  textbox "Customer name:" now "Ada Lovelace"
intent --intent "choose the Medium pizza size"                  # ✓ clicked radio "Medium" [e11]  radio "Medium" now "checked"
intent --intent "what customer name did the server receive?"   # "…custname": "Ada Lovelace"…  [e1]
```

## Impact: BU Bench V2.1, all 200 tasks

With intent, Sonnet 5.5 and GPT-6.1 Sol at low effort run the benchmark for **41% and 74% less** than without it, for **4.7 points less score** each. Both join the benchmark's score-vs-cost frontier, and Sonnet 5.5 with intent becomes its cheapest point.

**The skill's defaults are the configuration measured here:** kev-4b-vision as System 1, and RETRIEVE returning its most likely texts up to a 1,200-character budget.

| Configuration | Score | Cost per task |
| --- | --- | --- |
| Claude Sonnet 5.5, low effort, **with intent** | 29.6 | $0.101 |
| Claude Sonnet 5.5, low effort | 34.7 | $0.170 |
| GPT-6.1 Sol, low effort, **with intent** | 40.5 | $0.210 |
| GPT-6.1 Sol, low effort | 45.1 | $0.799 |
| Claude Opus 5.5, low effort (for reference) | 37.0 | $0.428 |

Score is the mean rubric score × 100; cost is the mean recorded model spend per task at list prices. The intent rows count all 200 tasks; the rows without intent are the benchmark page's existing runs.

**Paired on the same tasks:**

| Comparison | Tasks | Score | Raw difference (95% CI) | Cost |
| --- | --- | --- | --- | --- |
| Sonnet 5.5 low + intent vs Sonnet 5.5 low | 185 | 30.0 vs 34.7 | −4.7 (−7.7 to −1.8) | $0.100 vs $0.170, 41% less |
| Sol low + intent vs Sol low | 196 | 40.5 vs 45.1 | −4.7 (−8.3 to −1.0) | $0.209 vs $0.799, 74% less |
| Sol low + intent vs Opus 5.5 low | 190 | 40.5 vs 37.0 | +3.5 | $0.214 vs $0.428, 50% less |

**On the frontier**, Sonnet 5.5 low with intent (29.6, $0.101) is the new cheapest point. Sol low with intent (40.5, $0.210) sits between Sonnet 5.5 low (34.7, $0.170) and Sol low (45.1, $0.799). Opus 5.5 low (37.0, $0.428) drops off, since Sol with intent scores higher at half its cost.

**It is the first change to move this frontier.** Five earlier experiments on SLICC's browser skill and harness each left the score flat at equal or higher cost: a slimmer CLAUDE.md, a 1,000-character skill, guidance without the command reference, front-loaded web-task discipline, and a page-state helper (ai-ecoverse/slicc#3634, #3650, #3665, #3666, #3669).

### Read with care

- **The comparisons are not same-day.** The runs without intent are from 28 to 30 September (SLICC 6.205 to 6.226); the intent runs are from 4 to 6 October (SLICC 6.238). No new control runs were made for the full set.
- **Scores drift between days.** On a 40-task subset run with both arms on 4 October, the controls scored 3.8 points below the page's Sonnet 5.5 low run and 6.3 points above its Sol low run. Adjusted for that drift:
  - Sonnet 5.5 low with intent is about −0.9 (95% CI −7.1 to +5.6): about the same score at 59% of the cost.
  - Sol low with intent is about −11.0 (−20.2 to −2.0). At about 34 points for $0.207, that would put it just behind Sonnet 5.5 low and off the frontier.

  Each drift estimate rests on 40 tasks, and the intervals are wide.
- **Same-day subset (40 tasks, 4 October), intent against its own control:**
  - Sonnet 5.5 low: +0.4 (−5.6 to +7.1) at half the cost.
  - Sonnet 5.5 at default effort: −1.8 (−9.0 to +5.7) at 70% of the cost.
  - Sol low: −6.3 (−15.7 to +3.5) at 55% of the cost.
- **Cost counts the LLM only.** kev runs on the user's GPU. On the benchmark's hosted L4 runners, at an assumed $1 per GPU-hour, it would add roughly $0.03 to $0.23 per task.
- **Time per task is not comparable.** A run without intent ends with SLICC's 2-minute settle wait, which an intent run does not have. With 120 s taken off each control run, Sonnet 5.5 low with intent is about 18% faster than without it (154 s vs 187 s).
- **The benchmark configuration:** the defaults, driven by `intent-arm --toolset full` (see [references/evals.md](references/evals.md)). The agent had the whole shell, with the browser commands reachable only through `intent`. No run went around intent to the browser, and every run wrote its own answer.

## Context per call

In the full Sonnet 5.5 run, the agent's 1,876 stated intents returned a median of **418 characters** (90th percentile 920). By kind:

| Kind | Median characters |
| --- | --- |
| ACT | 371 |
| NAVIGATE | 467 |
| RETRIEVE | 545 |

The 40 times the agent asked for the whole page (`--full`), the snapshot's median was 5,903 characters. The 32 raw `snapshot` calls had a median of 45,614. The Sol run's 4,564 stated intents had a median of 448 characters.

Agents with the full shell also ran 1,898 raw playwright-cli commands through intent, 1,378 of them `eval`. Their output is whatever the agent's own script returns: a median of 75 characters, but a mean of 15,000.

## Games

In a hosted harness round (37130563705; 3 repeats per game, kev-4b-vision, an earlier build of this skill), both intent arms matched or beat raw playwright-cli at the same spend. Budget retrieval is what the skill now ships; the single-answer retrieval it was compared with is gone. The table shows mean rubric credit; Wikirace shows passes.

| Game | intent, single-answer retrieval (removed) | intent, budget retrieval (shipped) | playwright-cli agent |
| --- | --- | --- | --- |
| A Dark Room | 85% | 85% | 60% |
| Drug Wars | 100% | 73% | 70% |
| Kittens Game | 67% | 68% | 72% |
| Universal Paperclips | 78% | 87% | 90% |
| Seedship | 63% | 77% | 80% |
| Wikirace | 1/3 | 3/3 | 0/3 |
| **Overall** | **79%** | **78%** | **74%** |
| Spend | $10.73 | $10.94 | $10.74 |

A later round that tried fine-tuned System 1 bundles (37152484147) scored 66–71% while the same-day control rose to 79%. Most of that drop came from Drug Wars runs that ended early at a random police bust. Read together, intent is on par with raw playwright-cli on games, not clearly ahead.

On the default suite of forms and searches at the current head (round 37240155190, one run each), all three arms passed 5 of 5. The intent arms spent $0.61 against $2.10 for the playwright-cli agent. The bike-touring game's rubric credit was 50–60% against 80%.

## How to use it

```bash
intent pull                          # once: kev.js and onnxruntime-web from npm, 5.4 GB of kev-4b-vision weights (resumes)
intent --intent "open https://example.com"
intent --intent "what is the main heading?"
```

- **One step per call.** Each call is one intent: open, click, type, select, check, press, scroll, ask a question, verify a claim, wait for a state, or list matching links or rows.
- **Not sure means no action.** The answer starts with `?` and lists candidates with refs; pass the right one with `--ref e41`.
- **Raw commands still work.** Any playwright-cli command runs through intent with its intent stated: `intent screenshot --tab=ID --filename=page.png --intent "see the result list"`.
- **Keep the model loaded.** For many calls, `intent serve` keeps System 1 loaded.
- **Nothing to build.** kev.js and onnxruntime-web are npm dependencies in `package.json`; `intent pull` installs them into the skill's `node_modules` with `ipk install` and downloads the model weights.

[SKILL.md](SKILL.md) is what an agent reads: the intent kinds, how to phrase intents, and the escape hatches (`--candidates`, `--dry-run`, `--full`). How System 1 decides, and how accurate each model is: [references/system1.md](references/system1.md).

## Development

- **Tests:** `tests/*.test.js`, run with SLICC's `tst` (CI copies the skill onto a live leader and runs them).
- **Dependencies:** `package.json` pins `@ai-ecoverse/kev.js` and `onnxruntime-web` exactly; Renovate proposes the updates. The runtime reads both versions from it, so a bump needs no other change. Run `intent pull` again after one.
- **Evals:** `evals/harness` holds the goals and arms for `tools/harness-evals`; a push to the PR starts a hosted round.
- **Benchmark driver:** `intent-arm` drives both. See [references/evals.md](references/evals.md).
