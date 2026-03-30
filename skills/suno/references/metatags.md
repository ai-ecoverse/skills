# Suno Metatags Reference

## Character Limits

| Field | Limit |
|-------|-------|
| Lyrics | ~1,250 characters (slightly more in V5+) |
| Style prompt | Up to ~1,000 characters (V5.5); 4–7 descriptors recommended for cleanest results |

## Structure Tags

### Song Sections
```
[Intro]         [Verse]         [Verse 1]       [Verse 2]
[Pre-Chorus]    [Chorus]        [Post-Chorus]   [Hook]
[Bridge]        [Break]         [Outro]         [Instrumental]
[Fade Out]      [Fade In]       [Build-Up]      [End]
```

### Dynamic Markers
```
[Catchy Hook]           [Emotional Bridge]
[Powerful Outro]        [Soft Intro]
[Melodic Interlude]     [Percussion Break]
[Build]                 [Drop]
```

## Vocal Tags

### Voice Type
```
[Male Vocal]      [Female Vocal]    [Duet]
[Choir]           [Boy]             [Girl]
[Man]             [Woman]
```

### Vocal Style
```
[Whisper]         [Spoken Word]     [Raspy Voice]
[Operatic]        [Smooth]          [Breathy]
[Belting]         [Falsetto]        [Harmonies]
[Vulnerable Vocals]
```

### Narration/Speaking
```
[Female Narrator]   [Male Narrator]
[Reporter]          [Announcer]
```

## Sound Effects

### Audience/Crowd
```
[Cheering]        [Clapping]        [Applause]
[Audience laughing]
```

### Human Sounds
```
[Whispers]        [Screams]         [Sighs]
[Chuckles]        [Giggles]         [Groaning]
[Clears throat]   [Cough]
```

### Environmental
```
[Birds chirping]  [Phone ringing]   [Bell dings]
[Barking]         [Beeping]         [Silence]
```

## Advanced Formatting

### Inline Modifiers (in lyrics section)

Combine section tag with style cue:
```
[Verse 1] [moody, minimal synth]
Lyrics here...

[Chorus] [explosive, anthem energy]
Hook lyrics...
```

### Parameter Tags

```
[Tempo: Mid]        [Tempo: Fast]       [Tempo: Slow]
[Key: C minor]      [Key: G major]
[Mood: Defiant]     [Mood: Melancholic]
[BPM: 120]
```

### Parameterized Metatags (V5+)

Combine section tags with inline descriptors for per-section production control:
```
[Verse 1: whispered vocals, acoustic guitar only]
[Chorus: full band, anthemic, layered harmonies]
[Bridge: piano only, vulnerable vocals, half-tempo]
[Outro: fade out, ambient reprise, reverb-heavy]
[Intro: atmospheric, slow build, synth pads]
[Break: percussion only, tribal drums]
```

More reliable in V5/V5.5 than earlier versions. Use this instead of placing production notes as separate inline modifier tags.

### Ad-libs and Background Vocals

Parentheses in lyrics become background/echo:
```
I'm walking alone (alone)
Through the night (through the night)
(oh yeah)
(hey!)
```

## Style Prompt Components

### Genre Examples
```
Pop, Rock, Hip hop, R&B, Country, Jazz, Blues,
Electronic, EDM, Techno, House, Ambient, Lo-fi,
Metal, Punk, Indie, Alternative, Folk, Soul, Gospel,
Reggae, K-pop, J-pop, Latin, Afrobeat, Ska
```

### Mood/Energy Descriptors
```
Upbeat, Melancholic, Aggressive, Dreamy, Nostalgic,
Euphoric, Dark, Bright, Intimate, Epic, Playful,
Bittersweet, Triumphant, Haunting, Energetic, Chill
```

### Instrument Keywords
```
Acoustic guitar, Electric guitar, Piano, Synth,
Strings, Orchestra, Brass, Saxophone, Harmonica,
Bass, Drums, Percussion, Violin, Cello, Accordion,
Rhodes, Organ, Theremin, Mandolin, Banjo
```

### Production Style
```
Sparse, Lush, Raw, Polished, Lo-fi, Hi-fi,
Distorted, Clean, Reverb-heavy, Dry, Layered,
Stripped-down, Orchestral, Minimalist
```

## Advanced Settings (Custom Mode Sliders)

### Weirdness (0-100%)

Controls experimental vs conventional output.

| Value | Result |
|-------|--------|
| 0-30% | Safe, conventional, predictable, radio-friendly |
| 40-60% | Balanced (50% is default "normal") |
| 60-80% | Experimental, unexpected choices, creative risks |
| 80-100% | Chaos — may no longer resemble traditional music |

**Recommendations**:
- Radio-safe choruses: 35-45%
- Clear lyric-focused verses: 40-55%
- Experimental bridges: 55-70%

### Style Influence (0-100%)

Controls how strictly Suno follows your style prompt.

| Value | Result |
|-------|--------|
| 0-40% | Loose interpretation, AI takes liberties |
| 50-70% | Balanced adherence |
| 70-90% | Strict genre focus, detailed prompts honored |
| 90-100% | Very tight adherence, may sound rigid |

**Recommendations**:
- Detailed, intentional prompts: 70-85%
- Vague prompts, want AI creativity: 45-60%
- Genre fusion experiments: 50-65%

### Audio Influence (0-100%)

Only appears when uploading reference audio.

| Value | Result |
|-------|--------|
| 0-40% | Inspiration only, significant creative liberty |
| 50-70% | Moderate influence on rhythm/melody/vibe |
| 70-100% | Close mirror of reference track |

### Exclude Styles (Negative Prompting)

Tell Suno what NOT to include. More reliable in v5 than v4.5.

**Effective syntax**:
```
Instrumental only, no vocals
Upbeat pop with drums and bass, no guitars
Trap beat with piano and synths, no 808s
Acoustic folk, no electric instruments
```

**Ineffective syntax**:
```
Not like rock                              (too vague)
Without singing unless background only     (conditional)
No sounds that are bad                     (subjective)
```

**Use cases**:
- Pure instrumentals for sync licensing
- Remove problematic instruments from mix
- Eliminate frequency clashes (e.g., "no synth pads" in lo-fi)

### Vocal Gender

Set to Male, Female, or leave unset for AI choice.

- Explicit setting ensures consistency across extends/remixes
- Unset allows AI to match genre conventions

### Recommended Slider Combinations

| Goal | Weirdness | Style Influence |
|------|-----------|-----------------|
| Consistent radio chorus | 35-45% | 70-85% |
| Clear lyric focus | 40-55% | 55-70% |
| Experimental bridge | 55-70% | 45-60% |
| Safe pop production | 30-40% | 75-85% |
| Avant-garde exploration | 70-85% | 40-55% |

## Best Practices

### Tag Placement
- Most impactful in first 20-30 words
- Place around section changes
- Keep tags short (1-3 words)

### Quality Tips
- Focused style prompts (4–7 descriptors) = cleanest audio quality; V5.5 supports up to ~1,000 chars but more isn't always better
- Genre mashups risk quality degradation
- Specific instruments can conflict—test combinations
- Let AI fill creative gaps when unsure
- If v5 doesn't deliver expected sound, try v4.5 Pro

### What Works Well
```
Gothic, Alternative Metal, Ethereal Voice
```

### What Risks Poor Quality
```
Experimental avant-garde neo-classical post-punk fusion
with Indonesian gamelan and Swedish death metal growls
```

## Sources

- [Suno Wiki - Metatags List](https://sunoaiwiki.com/resources/2024-05-13-list-of-metatags/)
- [Suno Wiki - Style Prompts](https://www.suno.wiki/faq/getting-started/custom-mode-how-do-i-write-a-style-prompt/)
- [Suno Wiki - Prompt Structure](https://sunoaiwiki.com/tips/2024-05-04-how-to-structure-prompts-for-suno-ai/)
- [Suno Help - Creative Sliders](https://help.suno.com/en/articles/6141377)
- [Jack Righteous - Advanced Sliders Guide](https://jackrighteous.com/en-us/blogs/guides-using-suno-ai-music-creation/how-to-use-suno-s-advanced-sliders-weirdness-style-audio-influence)
- [Jack Righteous - Negative Prompting in v5](https://jackrighteous.com/en-us/blogs/guides-using-suno-ai-music-creation/negative-prompting-suno-v5-guide)
- [Sound on Sound - Understanding & Writing Lyrics Part 3](https://www.soundonsound.com/techniques/understanding-writing-lyrics-part-3)
- [Blake Crosley - Suno V5.5 Definitive Reference](https://blakecrosley.com/guides/suno)
- [Suno Help - V4.5 Better Prompts](https://help.suno.com/en/articles/5782977)
