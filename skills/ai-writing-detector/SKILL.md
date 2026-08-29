---
name: ai-writing-detector
description: Detect AI-generated writing in prose, docs, and creative text. Use when comparing vocabulary rates (`check-ai-words`), scanning LLM clichés (`check-llm-cliches`), classifying a file with Pangram (`pangram`), or attaching those findings to the review backlog (`check-llm-cliches review` / `pangram review`). Triggers on "Does this read like AI?", "Check for AI patterns", "Run Pangram on this", "Is this AI-generated?", "Detect LLM patterns".
allowed-tools: bash
---

# AI Writing Pattern Detector

## Analysis Workflow

1. **Read the target file** to analyze
2. **Scan for patterns** across these categories:
   - Vocabulary markers (overused AI words)
   - Structural patterns (em-dashes, rule of three, parallelisms)
   - Content patterns (legacy puffery, superficial analysis, hedging)
   - Style patterns (vague attribution, elegant variation)
   - LLM clichés from `check-llm-cliches` (therapist-voice, "no X, no Y" chains, chatbot leftovers)
3. **Validate findings** before reporting:
   - If confidence is Medium, re-read the adjacent 5–10 lines. A lone `delve` with no second pattern nearby is coincidental; downgrade rather than report
   - Check whether flagged patterns cluster in one section or spread across the text. Clustering reduces false-positive risk
   - For borderline cases, note ambiguity explicitly in the output rather than rounding up to High
4. **Report findings** with:
   - Pattern counts by category
   - Specific flagged passages with line numbers
   - Overall confidence assessment

## Pattern Categories

### High-Signal Vocabulary
Top indicators (see full 124-word list in [references/patterns.md](references/patterns.md)): `delve` (25x corpus increase), `showcasing` (9x), `underscore` (9x), `tapestry`, `pivotal`, `meticulous`, `testament`

### Structural Tells
- **Em-dash overuse**: More than 1 per 200 words
- **Rule of three**: "X, Y, and Z" constructions in series
- **Negative parallelisms**: "not X, but Y", "not just...it's...", "not only...but also"
- **Inline-header lists**: Bullet points with **bolded headers:** followed by text

### Content Patterns
Top indicators (see full examples in [references/patterns.md](references/patterns.md)):
- **Legacy/symbolism puffery**: "stands as a testament", "enduring legacy"
- **Superficial "-ing" analyses**: Sentences ending with "...reflecting its importance"

### Style Markers
Top indicators (see full examples in [references/patterns.md](references/patterns.md)):
- **Vague attribution**: "Experts argue", "Observers note"
- **Promotional tone**: "groundbreaking", "nestled in the heart of"

## Output Format

```
## AI Pattern Analysis: [filename]

### Summary
- **Confidence**: [Low/Medium/High] (based on pattern density)
- **Patterns found**: [count] across [categories] categories

### Vocabulary Markers ([count])
- Line X: "delve into the intricacies"
- Line Y: "pivotal role in fostering"

### Structural Patterns ([count])
- Em-dashes: [count] (rate: X per 1000 words)
- Rule of three: [count] instances
- Negative parallelisms: [count]

### Content Patterns ([count])
- Line X: Legacy puffery - "stands as a testament to..."
- Line Y: Superficial analysis - "...underscoring its significance"

### Flagged Passages
[Quoted passages with highest pattern density]
```

## Scripts

The scripts `check-ai-words`, `check-ai-patterns`, `check-llm-cliches`, and `pangram` must be available on `PATH`. If they are missing:

```bash
rg -n -i -e 'delve' -e 'tapestry' -e 'as a testament' -e "it.?s important to note" FILE
rg -n $'\u2014' FILE
```

### Quick Check: `check-ai-words`
Vocabulary-only analysis with rate comparison.

```bash
check-ai-words <file> [multiplier]
# multiplier default: 3 (flag words at 3x base rate)
```

### Full Analysis: `check-ai-patterns`
Comprehensive analysis including vocabulary, em-dashes, and phrase patterns.

```bash
check-ai-patterns <file> [multiplier]
```

Output includes:
- Em-dash rate per 1000 words (threshold: 5)
- Vocabulary violations with corpus base rates
- Common AI phrase detection
- Confidence score (0-7)

### Cliché scan: `check-llm-cliches`
Sentence-level detectors ported from Simon Willison's [LLM cliché highlighter](https://tools.simonwillison.net/llm-cliche-highlighter) (Apache-2.0). 38 patterns: "no X, no Y" chains, therapist-voice ("sit with that", "worth naming"), echoing sentence runs, chatbot leftovers, plus the Wikipedia "Signs of AI writing" group.

```bash
check-llm-cliches <file> [--json] [--all] [--pattern <id>]...
check-llm-cliches review --path <file> [--id <id>]
check-llm-cliches --test
check-llm-cliches --list
```

`colon-triple` is off unless `--all` (noisy in documentation). Attribution: [references/NOTICE-simonw-tools.txt](references/NOTICE-simonw-tools.txt). Catalog: [references/llm-cliches.md](references/llm-cliches.md). For a human-facing highlighter, use the upstream page rather than reimplementing the UI.

`check-llm-cliches review` emits a review-protocol contribution (see the review skill's `SOURCE_PROTOCOL.md`) so `review ingest` can attach findings to a card.

### Classifier: `pangram`
Optional Pangram API check. Needs `PANGRAM_API_KEY` or `pangram login` (stores the key in gitignored skill config). Docs: [references/pangram.md](references/pangram.md).

```bash
pangram <file> [--json] [--model pangram-4]
pangram review --path <file> [--id <id>]
pangram models
pangram login
```

Never pass the API key as a flag. Both `pangram` and `check-llm-cliches` are optional review integrations: `review ingest --path FILE` skips whichever is not on PATH.

### Data File: `references/ai_word_rates.txt`
Base rates per million words from ngrams.dev English corpus (23.6B words).

## Detailed Pattern Reference

Full lists: [references/patterns.md](references/patterns.md). Cliché catalog: [references/llm-cliches.md](references/llm-cliches.md).

## Confidence Calibration

| Pattern Density | Confidence | Notes |
|-----------------|------------|-------|
| 0-2 patterns | Low | Could be coincidence |
| 3-5 patterns | Medium | Warrants scrutiny |
| 6+ patterns | High | Strong AI indicators |
| Multiple categories | Higher | Cross-category patterns more telling |

Single patterns are weak signals. Clusters of patterns, especially across categories, indicate AI generation.
