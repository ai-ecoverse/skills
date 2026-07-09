/**
 * suno.jsh — Suno music generation CLI for SLICC
 *
 * Operates against the authenticated browser session on suno.com via
 * page-context fetch through the sliccy:browser bridge. The user must be
 * logged into suno.com in their browser; the script never reads, prints,
 * or stores the session token — every API call runs inside the page and
 * only the API response leaves the browser context.
 *
 * Usage:
 *   suno credits
 *   suno feed [--page=N]
 *   suno clip <clip_id>
 *   suno poll <clip_id> [--wait] [--timeout=300]
 *   suno search "query" [--type=public_song]
 *   suno personas [search-term] [--favorites]
 *   suno generate --lyrics "..." --tags "..." --title "..." [--persona <id>]
 *   suno generate --simple "description"
 *   suno generate --instrumental --tags "..."
 *   suno lyrics "description" [--wait]
 *   suno rename <clip_id> --title "..."
 *   suno visibility <clip_id> --public=true|false
 *   suno trash <clip_id> [--restore]
 *   suno extend <clip_id> [--infill]
 *   suno tags [tag1 tag2 ...]
 *   suno playlists | projects | me
 */

const DOMAIN = 'suno.com';
const BASE_URL = 'https://studio-api-prod.suno.com';
const DEFAULT_MODEL = 'chirp-fenix';

const browser = require('sliccy:browser');

// ─── Tab discovery ──────────────────────────────────────────────────────────

async function findTab() {
  const tab = await browser.findTab({ domain: DOMAIN });
  if (!tab) {
    console.error('No suno.com tab found. Open https://suno.com in your browser and log in first.');
    process.exit(1);
  }
  return tab;
}

// ─── Page-context fetch ─────────────────────────────────────────────────────
// Runs entirely inside the suno.com tab. The Clerk session token is read
// and consumed by fetch() in the same eval — it never leaves the page.

async function sunoFetch(tab, method, path, body) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const jsCode = `
    (async () => {
      try {
        const token = await window.Clerk.session.getToken();
        if (!token) return JSON.stringify({ error: 'NOT_AUTHENTICATED' });
        const opts = {
          method: ${JSON.stringify(method)},
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        };
        ${body ? `opts.body = ${JSON.stringify(JSON.stringify(body))};` : ''}
        const resp = await fetch(${JSON.stringify(url)}, opts);
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        return JSON.stringify({ status: resp.status, ok: resp.ok, data });
      } catch (e) {
        return JSON.stringify({ error: 'FETCH_ERROR', message: e.message });
      }
    })()
  `.trim();
  const parsed = await browser.evalAsync(tab, jsCode);
  if (parsed.error === 'NOT_AUTHENTICATED') {
    console.error('Not authenticated. Sign in to suno.com in the browser tab and retry.');
    process.exit(1);
  }
  if (parsed.error === 'FETCH_ERROR') {
    console.error('Page fetch error: ' + parsed.message);
    process.exit(1);
  }
  if (!parsed.ok) {
    if (parsed.status === 401 || parsed.status === 403) {
      console.error(`Auth failed (${parsed.status}). Re-login on suno.com and retry.`);
    } else if (parsed.status === 429) {
      console.error('Rate limited by Suno. Wait and retry.');
    } else {
      console.error(`HTTP ${parsed.status}:`, typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data));
    }
    process.exit(1);
  }
  return parsed.data;
}

let _tab = null;
async function api(method, path, body) {
  if (!_tab) _tab = await findTab();
  return sunoFetch(_tab, method, path, body);
}

// ─── Flag parsing ───────────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    }
  }
  return flags;
}


// ─── Commands ───────────────────────────────────────────────────────────────

const commands = {

  async generate(...args) {
    const flags = parseFlags(args);
    if (flags.simple !== undefined) {
      const description = typeof flags.simple === 'string'
        ? flags.simple
        : args.filter(a => !a.startsWith('--')).join(' ');
      if (!description) {
        console.error('Usage: suno generate --simple "a funky disco track about robots"');
        process.exit(1);
      }
      const body = {
        gpt_description_prompt: description,
        mv: flags.model || DEFAULT_MODEL,
        prompt: '',
        make_instrumental: flags.instrumental === 'true' || flags.instrumental === true,
        generation_type: 'TEXT',
        metadata: { create_mode: 'SIMPLE', lyrics_model: 'default' }
      };
      if (flags.persona) body.persona_id = flags.persona;
      if (flags.project) body.project_id = flags.project;
      return api('POST', '/api/generate/v2-web/', body);
    }
    const lyrics = flags.lyrics || flags.prompt;
    const tags = flags.tags || flags.style;
    const title = flags.title || '';
    if (!lyrics && !flags.instrumental) {
      console.error('Usage: suno generate --lyrics "[Verse]\\n..." --tags "rock" --title "..."');
      console.error('   or: suno generate --simple "description"');
      console.error('   or: suno generate --instrumental --tags "ambient"');
      process.exit(1);
    }
    const body = {
      prompt: lyrics || '',
      tags: tags || '',
      negative_tags: flags['negative-tags'] || flags.negative || '',
      title,
      mv: flags.model || DEFAULT_MODEL,
      make_instrumental: flags.instrumental === 'true' || flags.instrumental === true || (flags.instrumental !== undefined && !lyrics),
      generation_type: 'TEXT',
      metadata: { create_mode: 'CUSTOM' }
    };
    if (flags.persona) body.persona_id = flags.persona;
    if (flags.project) body.project_id = flags.project;
    return api('POST', '/api/generate/v2-web/', body);
  },

  async poll(...args) {
    const ids = args.filter(a => !a.startsWith('--'));
    const flags = parseFlags(args);
    if (ids.length === 0) {
      console.error('Usage: suno poll <clip_id> [...] [--wait] [--timeout=300]');
      process.exit(1);
    }
    const waitMode = flags.wait !== undefined;
    const timeout = parseInt(flags.timeout || '300', 10);
    const interval = parseInt(flags.interval || '5', 10);
    const idStr = ids.join(',');
    let clips = await api('GET', `/api/feed/?ids=${idStr}`);
    if (waitMode) {
      const start = Date.now();
      while (true) {
        const allDone = clips.every(c => c.status === 'complete' || c.status === 'error');
        if (allDone) break;
        if ((Date.now() - start) / 1000 > timeout) {
          console.error('Timeout waiting for clips.');
          break;
        }
        const pending = clips.filter(c => c.status !== 'complete' && c.status !== 'error');
        console.error(`Waiting... ${pending.length} clip(s) still ${pending[0]?.status || 'pending'}`);
        await new Promise(r => setTimeout(r, interval * 1000));
        clips = await api('GET', `/api/feed/?ids=${idStr}`);
      }
    }
    return clips.map(c => ({
      id: c.id, status: c.status, title: c.title,
      audio_url: c.audio_url, image_url: c.image_url,
      duration: c.metadata?.duration, tags: c.metadata?.tags
    }));
  },

  async feed(...args) {
    const flags = parseFlags(args);
    const page = parseInt(flags.page || '0', 10);
    const result = await api('POST', '/api/feed/v3', { page });
    const clips = result.clips || [];
    return {
      count: clips.length,
      has_more: result.has_more,
      clips: clips.map(c => ({
        id: c.id, title: c.title, status: c.status,
        model: c.model_name, audio_url: c.audio_url,
        created: c.created_at, is_public: c.is_public,
        duration: c.metadata?.duration, tags: c.metadata?.tags
      }))
    };
  },

  async clip(...args) {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) { console.error('Usage: suno clip <clip_id>'); process.exit(1); }
    return api('GET', `/api/clip/${id}`);
  },

  async search(...args) {
    const flags = parseFlags(args);
    const term = args.filter(a => !a.startsWith('--')).join(' ');
    if (!term) { console.error('Usage: suno search "query" [--type=public_song]'); process.exit(1); }
    return api('POST', '/api/search/', {
      search_queries: [{ term, search_type: flags.type || 'public_song' }]
    });
  },

  async lyrics(...args) {
    const flags = parseFlags(args);
    const prompt = args.filter(a => !a.startsWith('--')).join(' ');
    if (!prompt) { console.error('Usage: suno lyrics "description" [--wait]'); process.exit(1); }
    const result = await api('POST', '/api/generate/lyrics-pair', { prompt });
    const lyricsId = result.id;
    if (!lyricsId) { console.error('No lyrics ID returned'); return result; }
    if (flags.wait !== undefined) {
      const timeout = parseInt(flags.timeout || '60', 10);
      const start = Date.now();
      while (true) {
        const status = await api('GET', `/api/generate/lyrics/${lyricsId}`);
        if (status.status === 'complete') return status;
        if (status.status === 'error') { console.error('Lyrics generation failed'); return status; }
        if ((Date.now() - start) / 1000 > timeout) { console.error('Timeout'); return status; }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return { id: lyricsId, status: 'submitted', message: 'Use --wait to poll until complete' };
  },

  async 'lyrics-status'(...args) {
    const id = args[0];
    if (!id) { console.error('Usage: suno lyrics-status <id>'); process.exit(1); }
    return api('GET', `/api/generate/lyrics/${id}`);
  },

  async trash(...args) {
    const flags = parseFlags(args);
    const ids = args.filter(a => !a.startsWith('--'));
    if (ids.length === 0) { console.error('Usage: suno trash <id> [...] [--restore]'); process.exit(1); }
    return api('POST', '/api/gen/trash', { trash: flags.restore === undefined, clip_ids: ids });
  },

  async credits() {
    const info = await api('GET', '/api/billing/info/');
    return {
      plan: info.plan?.subscription_type,
      credits_left: info.total_credits_left,
      monthly_limit: info.monthly_limit,
      monthly_usage: info.monthly_usage,
      period_end: info.period_end
    };
  },

  async rename(...args) {
    const flags = parseFlags(args);
    const id = args.find(a => !a.startsWith('--'));
    if (!id || !flags.title) { console.error('Usage: suno rename <id> --title "..."'); process.exit(1); }
    return api('POST', `/api/gen/${id}/set_metadata/`, { title: flags.title });
  },

  async visibility(...args) {
    const flags = parseFlags(args);
    const id = args.find(a => !a.startsWith('--'));
    if (!id || flags.public === undefined) {
      console.error('Usage: suno visibility <id> --public=true|false');
      process.exit(1);
    }
    return api('POST', `/api/gen/${id}/set_visibility/`, { is_public: flags.public === 'true' || flags.public === true });
  },

  async extend(...args) {
    const flags = parseFlags(args);
    const id = args.find(a => !a.startsWith('--'));
    if (!id) { console.error('Usage: suno extend <id> [--infill]'); process.exit(1); }
    return api('POST', '/api/generate/concat/v2/', { clip_id: id, is_infill: flags.infill !== undefined });
  },

  async tags(...args) {
    const tags = args.filter(a => !a.startsWith('--'));
    if (tags.length === 0) return api('GET', '/api/generate/get_recommend_styles');
    return api('POST', '/api/tags/recommend', { tags });
  },

  async playlists() { return api('GET', '/api/playlist/me'); },
  async projects() { return api('GET', '/api/project/me'); },

  async personas(...args) {
    const flags = parseFlags(args);
    const term = args.filter(a => !a.startsWith('--')).join(' ') || '';
    const searchType = flags.favorites ? 'public_persona' : 'library_persona';
    const result = await api('POST', '/api/search/', {
      search_queries: [{ term, search_type: searchType }]
    });
    const personas = result.result?.[term]?.result || [];
    return personas.map(p => ({
      id: p.id, name: p.name,
      description: p.description?.slice(0, 100) || '',
      image_url: p.image_url, clip_id: p.root_clip_id
    }));
  },
  async voices(...args) { return commands.personas(...args); },

  async me() { return api('GET', '/api/user/me'); }
};

// ─── Main ───────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (!commands[cmd] && cmd !== 'voices')) {
  console.log(`suno — Suno music generation CLI

Requires: an authenticated suno.com tab open in the browser. The session
token is read and consumed inside the page context; it never leaves the
browser. The user must have logged into suno.com themselves.

Usage: suno <command> [args...]

Commands:
  generate     Generate a song (custom, simple, or instrumental)
  poll         Check clip status (with optional --wait)
  feed         List recent clips
  clip         Get a single clip
  search       Search songs, playlists, users
  lyrics       Generate lyrics from a description
  trash        Trash or restore clips
  credits      Show billing/credit info
  rename       Rename a clip
  visibility   Set clip public/private
  extend       Extend/continue a clip
  tags         Get tag recommendations
  playlists    List user playlists
  projects     List user projects
  personas     List user personas/voices
  me           Show user info

Note: 'generate' and 'extend' consume paid Suno credits. Always confirm
with the user before invoking them.

Examples:
  suno credits
  suno generate --simple "a funky disco track about robots"
  suno generate --lyrics "[Verse]\\n..." --tags "indie rock" --title "Test"
  suno poll abc123 --wait --timeout=120
  suno feed --page=0`);
  process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1);
}

const result = await commands[cmd](...args);
console.log(JSON.stringify(result, null, 2));