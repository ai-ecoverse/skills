---
name: suno
description: Write song lyrics formatted for Suno AI V5.5 music generation and submit them via direct API or browser automation. Includes `suno-api` CLI for generating songs, listing personas/voices, managing clips, and checking credits. Use when the user wants to create a song, write lyrics, compose music with AI, submit to Suno, list Suno personas, check Suno credits, or asks for help with Suno. Triggers on requests like "write me a song", "create lyrics about...", "help me with Suno", "compose a track", "song about...", "suno api", "suno credits", "suno personas".
allowed-tools: bash
---

# Suno Songwriting Assistant

Write lyrics formatted for Suno AI's Custom Mode with proper metatags, structure, and style prompts.

## End-to-End Workflow

1. **Clarify** — ask about genre, mood, theme, and vocal preference if not provided
2. **Draft lyrics** — use metatags, parameterized section headers, correct meter and rhyme
3. **Write style prompt** — structured colon format or producer run-on sentence
4. **Run prosody audit** — line-by-line syllable counts, rhyme scheme map, singability check
5. **Suggest sliders** — Weirdness, Style Influence, Audio Influence values
6. **Submit** — via `suno-api` CLI (preferred) or UI automation fallback
7. **Poll and iterate** — `suno-api poll <clip_id> --wait`, then refine weak sections with Song Editor

## How Suno Actually Works

**Critical insight**: Suno maps text into a probabilistic style-mesh rather than reading prompts literally.

### Genre Defaults and Escaping Pop Gravity

Nearly every genre gravitates toward "pop" unless actively countered (rock→pop, funk→pop, emo→pop). Genre clusters also blur: asking for "boom bap" still pulls trap elements due to training co-occurrence.

**Escape strategies:**
1. **Explicit exclusions**: "no trap", "no pop"
2. **Force unusual combinations**: "emo industrial", "math rock gospel"
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

## Style Prompt Formatting Rules

These rules apply to every style prompt you write.

### Use Periods and "and/with", Not Commas

Suno sees commas as opportunities to skip what follows. Use "and" and "with" to create run-on sentences, and use periods to end conceptual units.

**Wrong:**
```
acoustic guitar, male vocals, emotional, reverb
```

**Right:**
```
acoustic guitar with male vocals and emotional delivery and reverb-heavy production.
```

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

### Never Use Artist Names

Suno rejects prompts containing artist names (e.g., "Vangelis", "Beatles", "Billie Eilish"). Instead, describe the sonic characteristics:

| Instead of | Use |
|------------|-----|
| "Vangelis style" | "80s synth soundtrack, lush pads, cinematic, orchestral electronics" |
| "Beatles style" | "60s British Invasion, jangly guitars, vocal harmonies, Merseybeat" |
| "Billie Eilish style" | "dark pop, whispered vocals, minimal bass-heavy production" |
| "Johnny Cash style" | "sparse country, baritone vocals, acoustic guitar, train beat" |

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

## Realism and Synthesis Descriptors

For detailed descriptor vocabulary, see [references/descriptors.md](references/descriptors.md). Key principles:

**Acoustic/organic genres**: use **recording-engineer language** (e.g., "close mic presence", "natural timing drift", "tape saturation", "short room reverb") instead of abstract vibes. Describe the recording environment and performance artifacts.

**Electronic genres**: shift away from "realism" toward synthesis and modulation language (e.g., "FM synthesis bass", "LFO-driven movement", "resonant bandpass motion", "mono-stable low end"). Describe motion, harmonic shape, and stereo control rather than size or weight.

## Writing Guidelines

### Meter and Prosody (Suno-Specific)

**Key principle for Suno**: stressed syllables must fall on musical beats for Suno to render words correctly. Unstressed syllables between beats can vary — this creates natural flow. When the natural word stress conflicts with the beat, Suno will mispronounce or mangle the line.

- Keep syllable counts consistent within sections (e.g., all verse lines at 8 syllables)
- Mark stresses when drafting to verify alignment: `da-DUM da-DUM da-DUM da-DUM`
- Avoid padding with filler words ("it", "just", "so") to hit counts — restructure instead
- Genre affects expected meter: NDW/industrial favors 8–12 syllables, punchy and staccato; French chanson favors octosyllabic or alexandrine lines

### Rhyme

- **Chorus must rhyme** — this creates the hook. Use perfect rhymes ("night/light") for maximum impact.
- **Verses** can use slant rhyme ("home/alone") for a conversational feel.
- **Chorus consistency**: always repeat the chorus identically unless the user requests variation. Copy-paste, don't paraphrase.

### Contrast Between Sections

Verses: longer lines, more unstressed syllables, conversational.
Chorus: shorter lines, more stresses, punchy and direct.

### Suno-Specific Anti-patterns

- **Lyric bleed** in style prompts — the most common mistake (see Style Prompt Formatting Rules above)
- **Commas in style prompts** — use periods and "and/with" instead (see Style Prompt Formatting Rules above)
- **Artist names** — Suno rejects them; describe sonic characteristics instead
- **Stacking unrelated imagery** ("neon skies, electric hearts, endless dreams") — signals AI-generated lyrics; pick one metaphor and develop it
- **Paraphrasing the chorus** — always copy-paste it exactly
- **Padding lines** with filler words to hit syllable count — restructure instead

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
> Female contralto, androgynous, cold, monotone delivery, sharp enunciation, emotionally numb, sinister tone, industrial darkwave atmosphere with crushing bass and high-harmonic distortion.

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

## Style Prompt Examples

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

## Suno API (Direct)

The `suno-api` and `suno-token` shell commands provide direct API access to Suno, bypassing the UI entirely. Requires a suno.com tab open and authenticated in the browser.

### Quick start

```bash
# Check credits
suno-api credits

# List personas/voices
suno-api personas

# Generate a song (custom mode)
suno-api generate --lyrics "[Verse]\nHello world" --tags "rock, indie" --title "My Song"

# Generate with a persona
suno-api generate --lyrics "..." --tags "..." --title "..." --persona <persona-id>

# Generate (simple mode — AI writes lyrics)
suno-api generate --simple "a funky disco track about robots"

# List recent songs
suno-api feed

# Poll for completion
suno-api poll <clip_id> --wait

# Search
suno-api search "indie rock" --type=public_song
```

### Authentication

Uses Clerk JWT obtained from the browser via `suno-token`. Requires a suno.com tab open and logged in. Tokens auto-refresh on 401.

### All commands

`generate`, `poll`, `feed`, `clip`, `search`, `lyrics`, `lyrics-status`, `trash`, `credits`, `rename`, `visibility`, `extend`, `tags`, `playlists`, `projects`, `personas`, `voices`, `me`

Run `suno-api help` for full usage, or see [references/endpoints.md](references/endpoints.md) for the complete API reference.

## Submitting Songs via UI Automation

For UI-based submission (as fallback or when the API isn't available), use `playwright-cli` to automate the Create page. Navigate to Create, select Custom mode, optionally choose a persona, fill in lyrics and styles, set the title, configure advanced options, and click Create.

For the complete step-by-step guide, see [references/suno-ui-automation.md](references/suno-ui-automation.md).

## Full Song Examples

See [references/examples.md](references/examples.md) for complete lyrics with formatting.

## Reference

For detailed metatag lists and advanced techniques, see [references/metatags.md](references/metatags.md)

For detailed realism and synthesis descriptor vocabulary, see [references/descriptors.md](references/descriptors.md)
