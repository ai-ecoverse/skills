---
name: mixtape
description: Create themed music playlists and mixtapes with curated song lists, descriptions, and cover art prompts. Use when the user asks to build a playlist, create a mixtape, curate songs around a theme, or wants music recommendations organized as a cohesive collection. Triggers on requests like "make me a playlist", "build a mixtape", "curate songs about...", "themed playlist for...".
allowed-tools: bash
---

# Mixtape Creator

Create playlists that reward the attentive listener—privileging originals over famous covers, foreign adaptations over Anglophone defaults, and thematic depth over algorithmic obviousness.

## Deliverables

Every mixtape produces three artifacts:

1. **Song List** - 15-25 tracks with artist and title
2. **Description** - Playlist copy in music journalist voice
3. **Cover Prompt** - Image generation prompt for artwork

## Curation Philosophy

### Song Selection Hierarchy

1. **Originals over famous covers** - Lis Sørensen's "Brændt" over Natalie Imbruglia's "Torn"
2. **Foreign adaptations** - ABBA's Swedish "Honey, Honey", Bowie's Italian "Ragazzo Solo"
3. **Deep cuts over obvious hits** - The B-side, the album track, the live version
4. **Band names as meta-references** - Cake, Cream, Sweet, Hot Chocolate for dessert themes
5. **Album art connections** - Let It Bleed's Delia Smith cake earns Rolling Stones inclusion

### Thematic Architecture

Build dialectical structures within playlists:
- Bow Wow Wow's "I Want Candy" (feral wanting) answered by Jagger's "You Can't Always Get What You Want" (philosophical resignation)
- Hidden producer lineages (Steinman connections)
- Genre conversations across decades

### Research Sources

Consult in order:
1. User's Last.fm history - See [references/lastfm.md](references/lastfm.md)
2. secondhandsongs.com for cover genealogies - See [references/secondhandsongs.md](references/secondhandsongs.md)
3. Apple Music catalog for availability
4. Discogs for obscure pressings and foreign releases

## Output Formats

### Song List Format

```
# [PLAYLIST TITLE]

| Artist | Title | Note |
|--------|-------|------|
| Artist Name | Song Title | Brief connection explanation |
```

### Description Style

Write as a music journalist who aspired to Rolling Stone but got stuck titling Apple Music "essentials" playlists. Voice should be:
- Wry but not cynical
- Erudite without showing off
- Acknowledging hidden architecture without over-explaining

Template structure:
```
[TITLE]
[Category] • [Song Count] Songs • Updated [Year]

[Opening hook about what the playlist reveals]

[Middle paragraph on selection methodology - originals, adaptations, roads less traveled]

[Thematic architecture - the dialectic, the hidden connections]

Pairs well with: [ironic pairing suggestions]
```

### Cover Art Prompt Format

Prompts should be "artsy fartsy with emphasis on fartsy":
- Reference art history (Dutch Golden Age vanitas, Codex Manesse, Waldorf watercolors)
- Include unexpected juxtapositions
- Specify "aspect ratio 1:1" at end
- Embrace the absurd

Example structure:
```
[Primary subject] in the style of [art movement/period], [lighting description], [symbolic elements], [color palette], [self-aware artistic commentary], aspect ratio 1:1
```

## Platform Output

Present the completed mixtape as:
- A markdown table with Title, Artist, and Note columns
- Offer to create an inline sprinkle card (```shtml) showing the playlist as a styled, shareable card

## Process

1. **Understand the theme** - Ask clarifying questions if theme is ambiguous
2. **Research user taste** - If Last.fm username known, fetch top artists/tracks to anchor selections
3. **Research genealogies** - For candidate songs, check secondhandsongs.com for originals and foreign versions
4. **Build song list** - Apply selection hierarchy, aim for 15-25 tracks
5. **Find the dialectic** - Identify thematic tensions and hidden connections
6. **Write description** - Music journalist voice, acknowledge the architecture
7. **Create cover prompt** - Art historical absurdism
8. **Present to user** - Offer refinements, substitutions, additions

## Research Quick Reference

### Last.fm

Ask the user for their Last.fm username, or check memory/global memory for a previously stored one.

Fetch taste profile:
```
https://www.last.fm/user/{USERNAME}/library/artists
https://www.last.fm/user/{USERNAME}/library/tracks
```

Key data points:
- Top artists (overall and by period)
- Total scrobbles per artist (indicates depth of fandom)
- Recent listening for current mood

### SecondHandSongs

For each candidate song:
```
https://secondhandsongs.com/search/work?title={SONG}
```

On work pages, look for:
- "Original" badges with dates
- Foreign language versions (different titles)
- Unexpected cover artists
- Cover chains (A covered by B covered by C)

### Research Decision Tree

```
Is there a famous cover?
  → Find the original on SHS
  → Check if original fits user's taste profile

Is the song in English?
  → Search SHS for foreign adaptations
  → Prefer languages matching user's known preferences

Is the obvious version by a mega-star?
  → Find the deep cut, live version, or earlier recording
  → Check if a beloved artist from user's Last.fm covered it
```

