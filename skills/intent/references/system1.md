# System 1: how intent decides, and how well

## The pipeline

1. **Classify** the intent by its words: ACT, RETRIEVE, VERIFY, WAIT_FOR or NAVIGATE (`scripts/intent.js` `classify`). `--kind` overrides it.
2. **Filter.** Every control (or text segment) on the page is ranked by the intent's words:
   - idf-weighted overlap with labels and row context, with a bonus for a whole label;
   - ordinals: "the first" and "the top story" pick the 1st of a series like "165 comments", "21 comments", …;
   - a penalty for header and footer chrome.

   Typing ranks only fields. Text is cut into segments: the largest row, paragraph or list item under 400 characters, so "Born | April 28, 1906" stays together. Checked, selected and expanded states come from an in-page scan (`scripts/page-scan.js`), because slicc's snapshot does not print them (ai-ecoverse/slicc#3766).
3. **Choose.** The top 24 controls (16 texts) go to System 1 as one choice question with a NONE option. A -vision bundle also sees the screenshot, each candidate boxed and labelled with its ref (`scripts/vision.js`). VERIFY and WAIT_FOR ask a yes/no question over the top 6 segments.
4. **Act** when the top control reaches the threshold (0.6 for kev-4b-vision; `--sure` overrides it), otherwise return the candidates. **Answer** a RETRIEVE with System 1's most likely texts, in page order, up to 1,200 characters (`--retrieve-budget`), whatever its confidence in any single one: on BU Bench V2.1 this budget mode is what the agent used, and in a games round it was the only arm to win every Wikirace.

Enter is pressed in the page: slicc's `press Enter` sends no key code, so forms do not submit (ai-ecoverse/slicc#3765).

## Accuracy: why kev-4b-vision

Measured 2026-10-02/03 on 400 Mind2Web test_website steps (median 129 controls a page). Each step has two intents written by Sonnet 5.5: one from a caller that saw the control's label ("informed"), one from a caller that never saw the page ("blind"). RETRIEVE and VERIFY used 88 questions and 86 claims (half false) on 11 live pages. Latency is per System 1 call on a Mac GPU shared with other work. kev-4b-vision is the only System 1 the skill ships; the other rows are the alternatives it was measured against and are no longer options (another kev bundle still loads with `--from`).

| System 1 | ACT: right control, blind / informed | in top 3 | acts on (wrong actions) | RETRIEVE: right text / in top 3 | VERIFY | s per call |
| --- | --- | --- | --- | --- | --- | --- |
| kev-4b-vision (shipped, 5.4 GB) | 84.9% / 92.3% (184 intents) | 95.1% | 79% (4.3%) at 0.6 | 86.4% / 92.0% | 93.0% | 2.9 |
| kev-0.8b-vision (1 GB) | 69.0% / 83.5% | 94.3% | 49% (2.8%) at 0.4 | 63.6% / 76.1% | 77.9% | 0.7 |
| kev-0.8b-vision-wr1 (a fine-tune, not published) | 80.0% / 88.5% | 95.0% | 74.5% (5.0%) at 0.7 | 67.0% / 83.0% | 75.6% | 0.7 |
| Clef (Cloudflare Workers AI) | 81.5% / 91.5% | 94.3% | 74.5% (3.3%) at 0.7 | 87.5% / 92.0% | 97.7% | 0.7 |

## How the stages were chosen

- **The words alone** rank the right control first for 81% of informed intents but only 54% of blind ones. For blind intents it is in the top 24 95% of the time, so the model gets 24.
- **A 10-wise tournament over every control** (kev-0.6b-browser-use's method) was no better than the shortlist: kev-0.8b scored 65% vs 64%, and Clef 86.7% vs 86.1%. It was 3 to 9 times slower, and Workers AI rejected the largest pages.
- **The stock kev bundles get the wording they were trained on:** the intent as a goal, the shortlist as a Controls list, the options as `click …`/`type into …`. With it, 4b-vision scores 88.6%; with a plain "which control does the intent mean" it scores 83.2%.
- **kev's NONE does not veto:** the best other choice decides.
- **The threshold** is set where wrong actions stay at or under 5%. kev-4b-vision acts at 0.6 rather than 0.7: at 0.7 a hosted round left obvious picks unsure at 0.63–0.69, and the caller sees every result and can recover from a wrong one.

## Other kev bundles

`--from <dir or URL>` loads any kev bundle: a VFS directory, or the URL of a bundle's directory, whose manifest and listed files are fetched once into `/shared/cache/kev/bundles/`. A bundle may declare its question wording and its act, retrieve and verify thresholds in the `intent` block of its `manifest.json`; otherwise it acts at 0.5 and gets the menu wording (`scripts/intent.js` `s1Policy`, `questionStyle`). Fine-tunes for this tool are published on Hugging Face (`ai-ecoverse/kev-0.8b-vision-intent`, `ai-ecoverse/kev-4b-vision-intent`); in a games round they scored below the stock kev-4b-vision, so they are not recommended over it.
