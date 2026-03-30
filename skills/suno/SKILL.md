---
name: suno
description: Write song lyrics formatted for Suno AI music generation. Use when the user wants to create a song, write lyrics, compose music with AI, or asks for help with Suno. Triggers on requests like "write me a song", "create lyrics about...", "help me with Suno", "compose a track", "song about...".
---

# Suno Songwriting Assistant

Write lyrics formatted for Suno AI's Custom Mode with proper metatags, structure, and style prompts.

## Output Format

Always output these components:

### 1. Lyrics (in markdown code block)

```
[Intro]
(instrumental description if needed)

[Verse 1]
Lyrics here with proper meter
Each line should have consistent syllables
Rhymes enhance but don't force them

[Chorus]
The hook that repeats exactly
Every time it appears
(background vocal echo)

[Verse 2]
Continue the narrative
Match Verse 1's syllable count

[Bridge]
Tonal or thematic shift

[Chorus]
The hook that repeats exactly
Every time it appears
(background vocal echo)

[Outro]
Closing lines or instrumental fade
```

### 2. Style Prompt

Short, ~120 characters max:
```
Genre, mood descriptor, vocal type, key instruments
```

### 3. Advanced Settings (when relevant)

Suggest values for Suno's Custom Mode sliders:
```
Weirdness: 50%        (0=safe/conventional, 100=chaos/experimental)
Style Influence: 70%  (0=loose interpretation, 100=strict adherence)
Exclude: no guitars   (optional negative prompt)
Vocal: Male/Female    (or leave unset for AI choice)
```

## Formatting Rules

### Structure Tags (in square brackets)

```
[Intro]       [Verse]       [Pre-Chorus]
[Chorus]      [Post-Chorus] [Bridge]
[Outro]       [Hook]        [Break]
[Fade Out]    [Instrumental]
```

### Vocal/Performance Tags

```
[Male Vocal]      [Female Vocal]    [Duet]
[Choir]           [Spoken Word]     [Whisper]
[Harmonies]       [Raspy Voice]     [Operatic]
```

### Emphasis and Dynamics

- **ALL CAPS** for shouted/high-energy lines (use sparingly, genre-appropriate)
- **(parentheses)** for background vocals, echoes, ad-libs
- Call-and-response pattern:
  ```
  What do we want?
  (Freedom!)
  When do we want it?
  (Now!)
  ```

### Sound Effects (use sparingly)

```
[Cheering]    [Clapping]    [Whispers]
[Screams]     [Sighs]       [Chuckles]
```

## Writing Guidelines

### Meter and Stress Patterns

**Prosody**: Align stressed syllables with musical beats. The natural stress of words must match the rhythm.

**Common meters**:
- **Iambic** (da-DUM): unstressed-stressed — most natural for English
  ```
  a-LONE / to-NIGHT / I WALK / the STREET
  ```
- **Trochaic** (DUM-da): stressed-unstressed — more forceful, march-like
  ```
  WAL-king / THROUGH the / EMP-ty / CI-ty
  ```
- **Anapestic** (da-da-DUM): two unstressed, one stressed — galloping feel
  ```
  in the DARK / of the NIGHT / I a-WAKE
  ```

**Key principle**: Stressed syllables must fall on the beat. Unstressed syllables between them can vary—this creates natural flow without rigid counting.

**Avoid**:
- Padding lines with filler words ("it", "just", "so") to hit syllable counts
- Unnatural word order solely to fit meter
- Placing unstressed syllables on downbeats (sounds awkward)

### Syllable Counting

Count syllables per line. Keep consistent within sections:
```
I walk a-LONE down emp-ty STREETS  (8 syllables, 4 stresses)
The ci-ty LIGHTS re-flect my DREAMS (8 syllables, 4 stresses)
```

Mark stresses when drafting to verify alignment:
```
da-DUM da-DUM da-DUM da-DUM
```

### Rhyme Schemes

**Chorus**: Must rhyme — this creates the hook.

**Common schemes**:
- **ABAB** (alternating): Lines 1&3 rhyme, 2&4 rhyme
- **AABB** (couplets): Adjacent lines rhyme
- **ABCB** (loose): Only 2&4 rhyme — conversational feel
- **XAXA** (minimal): Only even lines rhyme

**Rhyme types**:
- **Perfect rhyme**: "night/light" — strongest, use in choruses
- **Slant rhyme**: "home/alone" — softer, good for verses
- **Internal rhyme**: Rhymes within a line — creates hooks

**Advanced schemes** for memorability:
- **AABBA** (limerick-like)
- **ABCCAB** (wrap-around)
- **AAAB/CCCB** (builds tension, releases on B)

### Contrast Between Sections

Verses: Longer lines, more unstressed syllables, conversational
Chorus: Shorter lines, more stresses, punchy and direct

Example shift (like "Lucy in the Sky"):
- Verse: da-da-DUM da-da-DUM (relaxed, 2 unstressed per stress)
- Chorus: DUM-da DUM-da (forceful, 1 unstressed per stress)

### Chorus Consistency

**Always repeat the chorus identically** unless user requests variation. Copy-paste, don't paraphrase.

## Quality Checklist

Before delivering lyrics:
- [ ] Syllable count consistent within sections
- [ ] Chorus rhymes and repeats exactly
- [ ] Metatags in square brackets
- [ ] Background vocals in parentheses
- [ ] Style prompt under 120 characters
- [ ] Genre-appropriate energy tags (ALL CAPS only where fitting)

## Handling User Input

### If user provides existing lyrics

1. Ask how to adjust (never reproduce copyrighted lyrics verbatim)
2. Suggest improvements: meter, rhyme, structure
3. Offer to rewrite in the style of, not copy

### If user provides a theme/concept

1. Ask about genre/mood preferences
2. Propose a structure (verse-chorus-verse-bridge-chorus)
3. Draft lyrics with proper formatting
4. Provide matching style prompt

## Style Prompt Rules

### Never Use Artist Names

Suno rejects prompts containing artist names (e.g., "Vangelis", "Beatles", "Billie Eilish"). Instead, describe the sonic characteristics:

| Instead of | Use |
|------------|-----|
| "Vangelis style" | "80s synth soundtrack, lush pads, cinematic, orchestral electronics" |
| "Beatles style" | "60s British Invasion, jangly guitars, vocal harmonies, Merseybeat" |
| "Billie Eilish style" | "dark pop, whispered vocals, minimal bass-heavy production" |
| "Johnny Cash style" | "sparse country, baritone vocals, acoustic guitar, train beat" |

### Style Prompt Examples

```
Operatic rockabilly, fast-paced, upbeat, male vocals, hymnic chorus, energetic
```

```
Industrial, krautrock, heavy German accent, industrial equipment, distortion
```

```
K-pop, cute, playful, upbeat, bubblegum pop, trap beats, bright synth, female vocals, aegyo
```

```
French yéyé synthwave, breathy female vocal, tenor saxophone, gated reverb, call and response, anthemic chorus, handclaps, 112 BPM
```

```
Dark wave rockabilly with NDW influence, 130 BPM, powerful sultry female vocals with punk edge, slapped upright bass, moody analog synths
```

```
Epic power ballad, orchestral rock, dramatic German male belting, piano, wailing guitar, choir
```

```
Psychobilly duet, male gruff and dark, female breathy and smooth
```

```
French yéyé pop, wistful yet bright, harpsichord, strings, handclaps, vintage organ, soft female vocal, Rococo elegance
```

```
Synthwave, chiptune, 8-bit, vocoder vocals, glitch, retro computing, algorithmic
```

```
Bavarian, klezmer
```

```
Rap Battle, male vocals, aggressive, metaphysical
```

## Full Song Examples

See [references/examples.md](references/examples.md) for complete lyrics with formatting.

## Reference

For detailed metatag lists and advanced techniques, see [references/metatags.md](references/metatags.md)
