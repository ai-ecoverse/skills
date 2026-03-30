---
name: suno
description: Write song lyrics formatted for Suno AI V5.5 music generation and submit them to suno.com. Use when the user wants to create a song, write lyrics, compose music with AI, or asks for help with Suno. Triggers on requests like "write me a song", "create lyrics about...", "help me with Suno", "compose a track", "song about...".
allowed-tools: bash
---

# Suno Songwriting Assistant

Write lyrics formatted for Suno AI's Custom Mode with proper metatags, structure, and style prompts.

## How Suno Actually Works

**Critical insight**: Suno does not read prompts like a human. It maps text into a probabilistic style-mesh, blending co-occurring musical concepts from training data.

### Genre Clouds

Genres cluster based on training co-occurrence:
- **Rap Cloud**: rap, trap, bass, hip hop, beat (asking for "boom bap" still pulls trap)
- **Orchestral Cloud**: orchestral, epic, cinematic, dramatic, piano
- **Indie Cloud**: indie, pop, acoustic, dreamy, psychedelic
- **Dark Electronic Cloud**: dark, synth, electro, synthwave, futuristic

### The Pop Gravity Well

Nearly every genre gravitates toward "pop" unless actively countered. Rock→pop (315B links), funk→pop (116B links), even emo→pop (12.2B links). Exclusions and unusual genre pairings help escape this pull.

### Escaping Default Behaviors

1. **Explicit exclusions**: "no trap", "no pop"
2. **Force weird combinations**: "emo industrial", "math rock gospel"
3. **Strategic contrast**: emphasize elements that naturally oppose unwanted defaults

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

Use the **colon-and-quotes format** for maximum clarity—this is a parsing hint, not cosmetic:

```
genre: "indie folk rock, 2020s bedroom pop"

vocal: "soft female alto, intimate whisper-to-belt, gentle vibrato, slight nasal quality"

instrumentation: "fingerpicked acoustic guitar, warm upright bass, sparse piano, light ambient pads"

production: "lo-fi intimacy, tape warmth, close-miked vocals, narrow stereo image, natural room reverb"

mood: "melancholic, nostalgic, late-night introspection"
```

For simpler prompts, use **producer-style run-on sentences**:
```
A fusion of 80s dark synthwave and modern cyberpunk aesthetics with extremely high-fidelity recording and professional mastering and analog warmth and controlled high-end and phase-coherent low end.
```

Up to ~1,000 characters in V5.5. Aim for 4–7 descriptors (~60–200 chars) for cleanest results; longer prompts give more control but risk competing descriptors.

### 3. Creative Sliders (when relevant)

Suggest values for Suno's Custom Mode sliders:
```
Weirdness: 50%           (0=conventional/radio-safe, 100=experimental/chaotic)
Style Influence: 70%     (0=loose interpretation, 100=strict adherence to style prompt)
Audio Influence: 50%     (only with reference audio; 0=inspiration only, 100=close mirror)
```

## Critical Formatting Rules

### Use Periods, Not Commas

Suno sees commas as opportunities to skip what follows. Use "and" and "with" to create run-on sentences:

**Wrong:**
```
acoustic guitar, male vocals, emotional, reverb
```

**Right:**
```
acoustic guitar with male vocals and emotional delivery and reverb-heavy production.
```

### Periods End Conceptual Units

Periods signal you are done with one instruction. Without them, instructions blend together.

### Avoid Lyric Bleed

Suno performs soft classification between conditioning text and performable text. Anything singable might get sung.

**Triggers to avoid in style prompts:**
- Short poetic lines
- Brackets that look like stage directions
- ALL CAPS slogans
- Quoted phrases that could be lyrics
- Empty lyrics box
- Rhythmic prose

**Keep style prompts metadata-like and dense**: technical descriptions do not scan as lyrics.

## Formatting Rules

### Structure Tags (in square brackets)

```
[Intro]       [Verse]       [Pre-Chorus]
[Chorus]      [Post-Chorus] [Bridge]
[Outro]       [Hook]        [Break]
[Fade Out]    [Instrumental]
```

### Parameterized Metatags (V5+)

Combine section tags with per-section production cues using colon or pipe syntax:

```
[Verse 1: whispered vocals, acoustic guitar only]
Lyrics here...

[Chorus: full band, anthemic, layered harmonies]
Hook lyrics...

[Bridge: piano only, vulnerable vocals, half-tempo]
Contrasting lyrics...
```

Or use the pipe format for stacked styling that overrides the global prompt:

```
[Chorus | anthemic chorus | stacked harmonies | modern pop polish]
Hook lyrics here...

[guitar solo | 80s glam metal lead | heavy distortion | whammy bar bends]

[Verse 2 | raspy lead vocal | emotional build-up | lo-fi warmth]
```

This gives per-section control over instrumentation, vocal style, and energy without putting production notes in the style prompt.

### Vocal/Performance Tags

```
[Male Vocal]      [Female Vocal]    [Duet]
[Choir]           [Spoken Word]     [Whisper]
[Harmonies]       [Raspy Voice]     [Operatic]
```

### Sound Effects (use sparingly)

```
[Cheering]    [Clapping]    [Whispers]
[Screams]     [Sighs]       [Chuckles]
```

## MAX Mode (Acoustic/Folk/Orchestral)

For acoustic, country, folk, singer-songwriter, and orchestral work, MAX Mode dramatically improves quality:

```
[Is_MAX_MODE: MAX](MAX)
[QUALITY: MAX](MAX)
[REALISM: MAX](MAX)
[REAL_INSTRUMENTS: MAX](MAX)
[START_ON: TRUE]
[START_ON: "write out the first few words of lyrics here"]

genre: "outlaw country, 70s singer-songwriter"

instruments: "single dreadnought acoustic, baritone male, vocal fry, blue notes, melismatic runs"

style tags: "tape saturation, close-mic presence, small room acoustics, handheld mic grit, dry & raw"
```

**Note**: MAX Mode has minimal effect on electronic/trap/hip-hop/synthwave—use structural prompting for those.

## Realism Descriptors (Acoustic Music)

For organic genres, use **recording-engineer language** instead of abstract vibes:

**Acoustic Realism:**
- Small room acoustics, room tone (air, faint hiss)
- Close mic presence, off-axis mic placement, proximity effect
- Single-mic capture, one-take performance
- Natural timing drift, natural dynamics (no brickwall)
- Breath detail (inhales, exhales)

**Performance Detail:**
- Mouth noise (lip noise, saliva clicks)
- Pick noise (attack, scrape), fret squeak, finger movement noise
- Chair creak and body shift

**Analog Character:**
- Tape saturation, analog warmth, harmonic grit
- Slight wow and flutter, gentle preamp drive

**Spatial:**
- Limited stereo (mono or narrow image)
- Short room reverb, early reflections emphasized
- Background noise floor consistent (not dead-silent)

## Synthesis Descriptors (Electronic Music)

For electronic genres, shift away from "realism" toward synthesis and modulation language:

**Instead of "big bass" request:**
- FM synthesis bass, wavetable movement, formant-driven bass
- Evolving modulation, LFO-driven movement, dynamic harmonic motion
- Resonant bandpass motion, sub-driven design with clean punch

**Avoiding Generic Sawtooth Synth:**
- Describe motion: "evolving modulation, non-repeating harmonic cycles"
- Shape harmonics: "rounded harmonic profile, odd-harmonic emphasis"
- Control high end: "smooth top end, clean high frequency rolloff"
- Kill stereo width: "center-focused bass, mono-stable low end"

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

### The One Metaphor Rule

Pick one metaphor and go deep. Stacking unrelated imagery ("neon skies, electric hearts, endless dreams") signals AI-generated lyrics. One image, many facets.

### Contrast Between Sections

Verses: Longer lines, more unstressed syllables, conversational
Chorus: Shorter lines, more stresses, punchy and direct

Example shift (like "Lucy in the Sky"):
- Verse: da-da-DUM da-da-DUM (relaxed, 2 unstressed per stress)
- Chorus: DUM-da DUM-da (forceful, 1 unstressed per stress)

### Chorus Consistency

**Always repeat the chorus identically** unless user requests variation. Copy-paste, don't paraphrase.

## Creative Anti-patterns

**Avoid at all costs:**
- Cliché and lazy phrasing — if you've heard it before, rewrite it
- Phrases masquerading as arguments (e.g., jargon that gestures at meaning without earning it)
- Being too on the nose — trust the listener
- Essays with line breaks instead of challenging poetry — if it could be prose, make it prose; if it's verse, make it earn the form

**Variation principle**: When writing multiple songs, don't repeat the same themes, imagery, or biographical details. Variation is exciting; repetition is boring. A character's backstory informs how they *see* the world — their undertone and sensibility — but should not appear as literal content in every song. Show the worldview operating on *new* material.

## Emphasis and Dynamics

- **ALL CAPS** for shouted/high-energy lines (use sparingly, genre-appropriate)
- **(parentheses)** for background vocals, echoes, ad-libs
- Call-and-response pattern:
  ```
  What do we want?
  (Freedom!)
  When do we want it?
  (Now!)
  ```

## Building Effective Personas

For consistent vocal character across generations, build a **character dossier**:

**Layer 1: Demographics and Timbre**
Age, gender, voice type, fundamental character

**Layer 2: Technical Delivery**
Enunciation, phrasing, breath control, vocal techniques

**Layer 3: Emotional Context**
Detached, passionate, vulnerable, aggressive

**Layer 4: Sonic Anchor**
Reference points that give Suno a clear target — describe the sonic quality rather than naming artists

**Example:**
> Female contralto, androgynous, cold, monotone delivery, sharp enunciation, emotionally numb, sinister tone, industrial darkwave atmosphere with HEALTH-like crushing bass.

Use the persona consistently across style prompts for a coherent "artist" sound. Suno's Persona Voices feature (V5.5) can lock this in for reuse.

## Quality Checklist

Before delivering lyrics:
- [ ] Syllable count consistent within sections
- [ ] Chorus rhymes and repeats exactly
- [ ] Metatags in square brackets
- [ ] Background vocals in parentheses
- [ ] Style prompt uses structured format (colons, periods, "and/with")
- [ ] No singable phrases in style prompt
- [ ] Genre-appropriate energy tags (ALL CAPS only where fitting)

### Prosody Audit

**Every song must pass a detailed prosody audit before submission.** No summary passes — a "PASS" without receipts is not a pass.

The audit must include:
- **Line-by-line syllable counts** for every sung line
- **Rhyme scheme map** per section (AABB, ABAB, etc.) with classification: true rhyme, near-rhyme, or assonance
- **Singability check** at the target BPM — how many syllables fit per bar? Flag lines that rush or drag
- **Genre-appropriate meter**: e.g., NDW = 8–12 syllables, punchy, staccato; French chanson = octosyllabic or alexandrine. Match the genre's conventions.

**Why this matters:** Rhyme fixes break meter. Meter fixes introduce filler. The only reliable gate is a line-by-line audit with visible evidence. If the checker says "PASS" without showing syllable counts, send it back.

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
genre: "operatic rockabilly, fast-paced, upbeat"

vocal: "male vocals, hymnic chorus"

mood: "energetic, triumphant"
```

```
genre: "industrial krautrock with heavy German accent"

instrumentation: "industrial equipment, distortion, motorik beat"

production: "raw, mechanical, relentless"
```

```
genre: "French yéyé synthwave, 112 BPM"

vocal: "breathy female vocal, call and response"

instrumentation: "tenor saxophone, gated reverb, handclaps"

mood: "anthemic chorus, nostalgic"
```

```
genre: "dark wave rockabilly with NDW influence, 130 BPM"

vocal: "powerful sultry female vocals with punk edge"

instrumentation: "slapped upright bass, moody analog synths"
```

## V5.5 Features

This skill is optimized for Suno V5.5 (March 2026), which produces 48kHz broadcast-quality audio.

### Key V5.5 Capabilities

- **Persona Voices**: Create reusable vocal identities for consistent sound across songs (Pro/Premier)
- **Voice Cloning**: Clone your own voice with a verification process (Pro/Premier)
- **Custom Models**: Train up to 3 personalized models from your song library (Pro/Premier)
- **My Taste**: Adaptive preference system that learns from your generation history (all users)
- **Song Editor**: Replace sections, extend, crop, and fade for iterative refinement
- **Creative Sliders**: Weirdness, Style Influence, and Audio Influence for fine-tuning generation personality
- **12-stem separation**: Export individual instrument stems for DAW mixing (Pro/Premier)

### Tips for V5.5

- Style prompts can now be up to ~1,000 characters — use the extra space for detailed instrumentation and production notes when needed
- Parameterized metatags (`[Verse: descriptor]` syntax) are more reliably followed in V5.5
- Use Persona Voices for consistency when generating multiple songs for the same "artist"
- The Song Editor is more cost-efficient than regenerating entire songs — fix weak sections instead

## Submitting Songs to Suno

After writing lyrics, you can automate submission to Suno's Create page using `playwright-cli`. The workflow: navigate to the Create page, select Custom mode, optionally choose a persona, fill in lyrics and styles, set the title, configure advanced options, and click Create.

For the complete step-by-step guide with commands and examples, see [references/suno-ui-automation.md](references/suno-ui-automation.md).

## Full Song Examples

See [references/examples.md](references/examples.md) for complete lyrics with formatting.

## Reference

For detailed metatag lists and advanced techniques, see [references/metatags.md](references/metatags.md)
