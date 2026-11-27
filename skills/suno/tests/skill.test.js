// skill.test.js — tst suite for the suno skill, which has no scripts: it checks that
// SKILL.md stays valid and in step with Suno's MCP server.
//
// Run from skills/suno/:  tst tests/skill.test.js

import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

const ROOT = process.cwd();
const SKILL = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');

// The tool names api.suno.com/mcp listed on 2026-11-27 (61 tools), without the mcp__Suno__ prefix.
const SERVER_TOOLS = new Set(
  `account_me account_upgrade account_usage audio_analysis audio_covers_create audio_create
  audio_download audio_edit audio_extensions_create audio_full_song audio_like audio_listen
  audio_listen_wait audio_lyrics_alignment audio_mashups_create audio_midi audio_retrieve
  audio_settings audio_stems_create audio_stems_retrieve audio_unlike audio_upload_complete
  audio_upload_create audio_wait characters_list characters_save custom_models_list image_create
  library_liked library_list library_search midi_upload_complete midi_upload_create
  playlists_add_clips playlists_create playlists_list playlists_list_clips playlists_remove_clips
  sequence_create sequence_export sequence_generate sequence_get sequence_list sequence_update
  sounds_create speech_create video_assemble video_create visuals_download visuals_library
  visuals_models visuals_show visuals_upload_complete visuals_upload_consent visuals_upload_create
  visuals_wait voices_list voices_start workspaces_create workspaces_list workspaces_update_clips`.split(/\s+/)
);

function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  ok(m, 'SKILL.md starts with frontmatter');
  const fields = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (kv) { key = kv[1]; fields[key] = kv[2]; } else if (key) fields[key] += ` ${line.trim()}`;
  }
  return fields;
}

test('frontmatter: name matches the folder; description fits 1024 characters', () => {
  const f = frontmatter(SKILL);
  is(f.name, 'suno');
  ok(f.description && f.description.length > 200, 'a description long enough to route on');
  ok(f.description.length <= 1024, `description is ${f.description.length} characters`);
});

test('every Suno tool the skill names exists on the server', () => {
  const named = new Set();
  for (const m of SKILL.matchAll(/`(?:mcp__Suno__)?([a-z]+(?:_[a-z]+)+)`/g)) {
    if (/^(audio|account|library|playlists|sounds|speech|voices|visuals|sequence|workspaces|characters|custom|image|video|midi)_/.test(m[1])) named.add(m[1]);
  }
  for (const m of SKILL.matchAll(/mcp__Suno__([a-z_]+)/g)) if (m[1] !== '') named.add(m[1]);
  named.delete('');
  ok(named.size >= 10, `found ${named.size} tool names`);
  const unknown = [...named].filter((n) => !n.endsWith('_') && !SERVER_TOOLS.has(n));
  is(unknown, [], 'no unknown tool names');
});

test('the playlists_* wildcard matches tools that exist', () => {
  ok([...SERVER_TOOLS].some((n) => n.startsWith('playlists_')));
});

test('every referenced file exists', () => {
  const refs = [...SKILL.matchAll(/`(references\/[^`]+\.md)`/g)].map((m) => m[1]);
  ok(refs.length >= 3);
  is(refs.filter((r) => !fs.existsSync(path.join(ROOT, r))), []);
});

test('nothing points at the removed suno CLI or UI automation', () => {
  const files = ['SKILL.md', ...fs.readdirSync(path.join(ROOT, 'references')).map((f) => `references/${f}`)];
  const stale = files.filter((f) => /suno\.jsh|suno-ui-automation|endpoints\.md|`suno [a-z]|^\s*suno (generate|poll|credits|personas|feed)\b/m.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  is(stale, []);
});

test('generation is gated on the user\'s yes, and max_mode only on request', () => {
  ok(/spends the user's credits/.test(SKILL));
  ok(/once they've said yes/.test(SKILL));
  ok(/`max_mode` only when the user asks for Max Mode by name/.test(SKILL));
});
