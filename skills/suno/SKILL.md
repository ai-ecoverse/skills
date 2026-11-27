---
name: suno
description: Write song lyrics and style prompts for Suno and make the songs through Suno's own MCP server (api.suno.com/mcp), signed in as the user. Use when the user wants to write a song or lyrics, compose a track with AI, generate, cover, extend or mash up a Suno song, make stems or a sound effect, check Suno credits, browse their Suno library or playlists, ask how a song sounds (tempo, key, mood), or asks for help with Suno. Triggers on "write me a song", "song about…", "lyrics for…", "make this into a Suno track", "suno credits", "my Suno songs", "cover this song", "extend this song".
allowed-tools: bash
---

# Suno

Write the song here; make it through Suno's MCP server. Every Suno tool is named
`mcp__Suno__<tool>` (in SLICC, call them from a codemode script; elsewhere, add
`https://api.suno.com/mcp` as an MCP server). It signs in with the user's suno.com
account by OAuth: in SLICC, under Settings › MCP servers. There is no CLI.

## Workflow

1. **Ask** for genre, mood, theme and vocal if the user gave none.
2. **Write** lyrics, a style prompt, and optionally a negative style and sliders (below).
3. **Audit** the lyrics line by line (syllables, rhyme, stress on the beat) and fix them.
4. **Show** the final lyrics, style, title and model. Generating spends the user's credits
   (one `audio_create` call makes 2 songs): make it only once they've said yes, or when
   they've already told you to go ahead.
5. **Make** it: `audio_create`, then `audio_wait` with every id from `clip_ids`.
6. **Check** it: `audio_listen` asks Suno's listener about a finished song (free, answer in
   under a minute through `audio_listen_wait`). Report every song made, not only the first.

## The tools you need most

| Task | Tool | Notes |
| --- | --- | --- |
| Credits, plan, allowed models | `account_usage` | `suno_account.credits_remaining`; `allowed_models` lists the `model` labels you may send |
| Write and generate a song | `audio_create` | **Custom:** `lyrics` + `style` + `title`. **Simple:** `description` only. Mixing them is a 400 |
| Wait for it | `audio_wait` | `ids: clip_ids`, `until: "complete"` for the finished file; call again while pending |
| Ask how it sounds | `audio_listen` → `audio_listen_wait` | ask for JSON ("End with a JSON block with bpm and key") |
| Cover, extend, mash up | `audio_covers_create`, `audio_extensions_create`, `audio_mashups_create` | or `audio_create` with `reference_audio_ids` and a `description` |
| Stems, MIDI, sound effects, speech | `audio_stems_create`, `audio_midi`, `sounds_create`, `speech_create` | |
| Library and playlists | `library_list`, `library_search`, `library_liked`, `playlists_*` | lyrics come from `audio_retrieve` |
| Download | `audio_download` | call without `confirm`; on `requires_credit` ask before `confirm: true` |

Other tools (`describeTool` / `describeNamespace('mcp__Suno')` in codemode) cover voices,
custom models, characters, sequences, workspaces, images and video. Read a tool's
description before first use: they spell out which arguments clash.

```js
// codemode: a custom-mode song, both takes, then a check of each
const t = r => r.content.map(c => c.text).join('\n');
const made = JSON.parse(t(await tools.mcp__Suno__audio_create({
  title: 'Inside Your Browser', lyrics, style: 'bright synthpop with driving electronic drums and a clear female vocal',
  idempotency_key: 'inside-your-browser-1',          // a retry with this key returns the same songs
})));
const done = JSON.parse(t(await tools.mcp__Suno__audio_wait({ ids: made.clip_ids, until: 'complete' })));
// done.clips[i]: {id, status, title, song_url, …}; status "error" carries `error`
```

Arguments worth knowing on `audio_create`: `model` (omit for the plan default; say which
you send), `negative_style` (custom mode only), `controls` (`weirdness`, `style_influence`
0–1, `variety` 0–4; omit to keep defaults, `0` is a real value), `duration` (15–360 s),
`instrumental`, `voice_id`, and `max_mode` only when the user asks for Max Mode by name,
since it multiplies the cost. Limits: `lyrics` 5,000 characters, `style` 1,000.

## Lyrics

- Section tags in square brackets: `[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Bridge] [Outro]`.
  Per-section cues go inside the tag: `[Chorus: full band, stacked harmonies]` or
  `[Verse 2 | raspy lead | lo-fi warmth]`.
- `(parentheses)` are background vocals and ad-libs; ALL CAPS is shouted, use it sparingly.
- Repeat the chorus word for word every time. The chorus rhymes (perfect rhymes); verses
  may use slant rhymes.
- Keep syllable counts steady within a section and put stressed syllables on the beat;
  Suno mangles words whose stress fights the meter. Restructure a line instead of padding
  it with "just", "so", "it".
- Verses run longer and conversational; the chorus is short, punchy and direct.
- Develop one image instead of stacking unrelated ones ("neon skies, electric hearts").
- Never reproduce copyrighted lyrics; rewrite in the manner of, not copy.

**Audit before showing:** a table with each sung line's syllable count, each section's
rhyme scheme (AABB, ABAB; true, near or assonance), and lines that would rush or drag at
the target tempo. A "pass" without the counts isn't a pass.

## Style prompt

- 4–7 descriptors, about 60–200 characters: genre and era, vocal, instruments, production,
  mood, optional tempo. Either labelled lines (`genre: "…"`, `vocal: "…"`) or one
  producer-style sentence joined with "and" and "with": Suno reads commas as optional.
- Keep it metadata-like. Short poetic lines, quoted phrases, ALL CAPS slogans and
  bracketed directions can get sung (lyric bleed).
- No artist names: Suno rejects them. Describe the sound ("60s British Invasion, jangly
  guitars, vocal harmonies").
- Most genres drift toward pop. Counter it with `negative_style` ("pop, trap"), unusual
  pairings ("math rock gospel"), or by stressing the opposing elements.
- Acoustic, folk and orchestral: recording-engineer language ("close-miked, tape
  saturation, small room"). Electronic: synthesis language ("FM bass, LFO-driven filter,
  mono low end").

## References

- `references/metatags.md`: every structure, vocal, instrument and effect tag.
- `references/descriptors.md`: realism and synthesis vocabulary.
- `references/examples.md`: complete songs with style prompts.
