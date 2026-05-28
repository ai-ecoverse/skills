---
name: mixtape
description: Create themed music playlists and mixtapes with curated song lists, descriptions, and cover art prompts. Use when the user asks to build a playlist, create a mixtape, curate songs around a theme, or wants music recommendations organized as a cohesive collection. Triggers on requests like "make me a playlist", "build a mixtape", "curate songs about...", "themed playlist for...".
allowed-tools: bash
---

# Mixtape Creator

Create playlists that reward the attentive listener—privileging originals over famous covers, foreign adaptations over Anglophone defaults, and thematic depth over algorithmic obviousness.

## Deliverables

Every mixtape produces three artifacts:

1. **Song List** - 15–25 tracks with artist and title
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

Build dialectical structures: Bow Wow Wow's "I Want Candy" (feral wanting) answered by Jagger's "You Can't Always Get What You Want" (philosophical resignation). Surface hidden producer lineages (Steinman connections) and genre conversations across decades.

### Research Sources

Consult in order: user's Last.fm history → secondhandsongs.com for cover genealogies → Apple Music catalog for availability → Discogs for obscure pressings and foreign releases.

## Output Formats

### Song List

```
# [PLAYLIST TITLE]

| Artist | Title | Note |
|--------|-------|------|
| Artist Name | Song Title | Brief connection explanation |
```

### Description

Voice: wry but not cynical, erudite without showing off. Use the structure below:

```
[TITLE]
[Category] • [Song Count] Songs • Updated [Year]

[Opening hook about what the playlist reveals]
[Selection methodology — originals, adaptations, roads less traveled]
[Thematic architecture — the dialectic, the hidden connections]

Pairs well with: [ironic pairing suggestions]
```

### Cover Art Prompt

Reference art history with unexpected juxtapositions and self-aware absurdist tone. Include: art movement/period, lighting, symbolic elements, color palette, brief artistic commentary, and `aspect ratio 1:1`. Draw from: Dutch Golden Age vanitas, Codex Manesse, Waldorf watercolors, etc.

```
[Primary subject] in the style of [art movement/period], [lighting description], [symbolic elements], [color palette], [self-aware artistic commentary], aspect ratio 1:1
```

## Platform Output

Present the completed mixtape as:
- A markdown table with Artist, Title, and Note columns
- Offer to create an inline sprinkle card (`shtml`) showing the playlist as a styled, shareable card

## Process

1. **Understand the theme** - Ask clarifying questions if theme is ambiguous
2. **Research user taste** - If Last.fm username known, fetch top artists/tracks to anchor selections
3. **Research genealogies** - For candidate songs, check secondhandsongs.com for originals and foreign versions
4. **Build song list** - Apply selection hierarchy, aim for 15–25 tracks
5. **Validate song list** - Confirm track count is within 15–25 range; verify originals and foreign-language versions via SecondHandSongs before proceeding; add or cut tracks as needed
6. **Find the dialectic** - Identify thematic tensions and hidden connections
7. **Write description** - Music journalist voice, acknowledge the architecture
8. **Create cover prompt** - Art historical absurdism
9. **Present to user** - Offer refinements, substitutions, additions

## Research Quick Reference

> **Note:** All scraping snippets are heuristic and depend on site markup. If parsing fails, ask the user to paste their top artists/tracks directly, or verify results against the rendered page.

### Last.fm

Ask the user for their Last.fm username, or check memory/global memory for a previously stored one.

```bash
curl -s "https://www.last.fm/user/{USERNAME}/library/artists" > /tmp/lastfm_artists.html

python3 - <<'EOF'
import re
html = open('/tmp/lastfm_artists.html').read()
artists = re.findall(r'class="link-block-target">([^<]+)', html)
counts = re.findall(r'class="chartlist-count-bar-value">\s*(\S+) scrobbles', html)
for a, c in zip(artists, counts):
    print(f"{c:>10}  {a}")
EOF
```

Key data points: top artists overall and by period, scrobble depth per artist, recent listening for current mood.

### SecondHandSongs

Substitute `{SONG}` with the candidate title and URL-encode it (titles with spaces or reserved characters will otherwise reject the curl request):

```bash
SONG="Sweet Jane"
curl -sG "https://secondhandsongs.com/search/work" --data-urlencode "title=${SONG}" > /tmp/shs_results.html

python3 - <<'EOF'
import re
html = open('/tmp/shs_results.html').read()
works = re.findall(r'href="(/work/[^"]+)"[^>]*>([^<]+)</a>', html)
badges = re.findall(r'class="[^"]*badge[^"]*">([^<]+)</span>', html)
for w in works: print(w)
for b in badges: print(b.strip())
EOF
```

On work pages, look for: "Original" badges with dates, foreign-language versions, unexpected cover artists, and cover chains (A covered by B covered by C).

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
