---
name: ai-writing-detector
description: Detect patterns of AI-generated writing in prose, creative writing, and technical documentation. Use when analyzing text for AI tells, checking if content reads like AI, reviewing drafts for machine-generated patterns, or auditing writing authenticity. Triggers on requests like "Does this read like AI?", "Check for AI patterns", "Analyze for AI writing", "Is this AI-generated?", "Detect LLM patterns".
allowed-tools: bash
---

# AI Writing Pattern Detector

Analyze text for telltale patterns of AI-generated content. Returns specific findings with line references and confidence indicators.

## Analysis Workflow

1. **Read the target file** to analyze
2. **Scan for patterns** across these categories:
   - Vocabulary markers (overused AI words)
   - Structural patterns (em-dashes, rule of three, parallelisms)
   - Content patterns (legacy puffery, superficial analysis, hedging)
   - Style patterns (vague attribution, elegant variation)
3. **Report findings** with:
   - Pattern counts by category
   - Specific flagged passages with line numbers
   - Overall confidence assessment

## Pattern Categories

### High-Signal Vocabulary (124+ words)
Top indicators with usage increases: `delve` (25x), `showcasing` (9x), `underscore` (9x), `tapestry`, `landscape`, `realm`, `multifaceted`, `pivotal`, `meticulous`, `comprehensive`, `vibrant`, `foster`, `intricate`, `testament`, `beacon`, `symbiosis`, `holistic`, `myriad`

### Structural Tells
- **Em-dash overuse**: More than 1 per 200 words
- **Rule of three**: "X, Y, and Z" constructions in series
- **Negative parallelisms**: "not X, but Y", "not just...it's...", "not only...but also"
- **Inline-header lists**: Bullet points with **bolded headers:** followed by text

### Content Patterns
- **Legacy/symbolism puffery**: "stands as a testament", "enduring legacy", "pivotal role"
- **Superficial "-ing" analyses**: Sentences ending with "...reflecting its importance" or "...highlighting the significance"
- **Challenges sections**: "Despite its [positive], [subject] faces challenges..."
- **Hedging preambles**: "It's important to note", "worth mentioning"

### Style Markers
- **Vague attribution**: "Experts argue", "Observers note", "Industry reports suggest"
- **Elegant variation**: Avoiding word repetition by cycling synonyms unnaturally
- **Promotional tone**: "groundbreaking", "stunning", "nestled in the heart of"
- **Hydrogen Jukebox**: Abstract/concrete "eyeball kicks" crammed into every phrase (nostalgebraist, 2024)

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

### Data File: `references/ai_word_rates.txt`
Base rates per million words from ngrams.dev English corpus (23.6B words).

## Detailed Pattern Reference

For comprehensive pattern lists with examples, see [references/patterns.md](references/patterns.md).

## Confidence Calibration

| Pattern Density | Confidence | Notes |
|-----------------|------------|-------|
| 0-2 patterns | Low | Could be coincidence |
| 3-5 patterns | Medium | Warrants scrutiny |
| 6+ patterns | High | Strong AI indicators |
| Multiple categories | Higher | Cross-category patterns more telling |

Single patterns are weak signals. Clusters of patterns, especially across categories, indicate AI generation.

