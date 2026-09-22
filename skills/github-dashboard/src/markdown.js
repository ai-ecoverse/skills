/* ------------------------------------------------------------------------
   Phase 7l — markdown rendering for the GitHub dashboard's quick view.

   THE FIRST EXTRACTED MODULE. The panel's ~127 KB inline script stays inline;
   this file is bundled by ../build.sh into a classic <script> inside the
   .shtml, exposing exactly one global (GHMarkdown). Converting the rest of the
   panel to modules is a LATER phase, one unit at a time.

   ====================================================================
   WHY THIS FILE IS PARANOID
   ====================================================================
   A sprinkle panel is NOT sandboxed from the filesystem. Measured inside a
   live panel: the bridge enumerated every sibling scoop's folder and ran a
   shell command with exit 0, while that scoop's own agent shell sees only its
   own. The bridge also exposes writeFile, rm, fetch and agent.

   The text this module renders comes from GitHub issue bodies and comments —
   authored by ANYONE who can comment on a watched repo. So script execution
   inside this panel is arbitrary command execution with full VFS read/write.
   That is why `marked(md)` piped into innerHTML is not an acceptable
   implementation here, however common it is elsewhere.

   FOUR INDEPENDENT LAYERS, each of which alone would stop the fixtures:

     1. marked never sees a chance to make a dangerous URL: the link and image
        renderers are overridden and run the scheme allowlist themselves.
     2. DOMPurify sanitises with an explicit tag/attribute allowlist (no
        script, iframe, object, embed, form, style, svg, math, img, no event
        handlers, no target) and a URI allowlist of http/https/mailto only.
     3. RETURN_DOM_FRAGMENT: this module never assigns untrusted HTML into the
        live document. DOMPurify parses in its own inert document and hands
        back nodes; we only ever appendChild.
     4. A post-pass over the fragment WE own re-checks every anchor: any href
        that is not http/https/mailto is stripped, and every surviving link
        gets target="_blank" + rel="noopener noreferrer".

   Images: ALLOWED FROM TRUSTED HOSTS ONLY (phase 7m). Requested: "I think images are
   fine, if they come from a trusted host like github or githubusercontent." The
   7l reasoning — a remote image is a beacon telling an arbitrary host when the
   operator opened a card — still holds for every OTHER host, so this is a host allowlist,
   not a re-enable. GitHub already knows when he views a card, so a fetch to
   GitHub reveals nothing it does not already have.

   Three properties make that safe to implement:
     a. the host is decided by the URL API, NEVER a regex. A regex host test is
        the classic bypass, and the parser handles cases a regex cannot: a
        backslash ends the authority (`https://github.com\@evil.com` really IS
        github.com), IDNA maps `github\u3002com` onto github.com, and credentials
        move the host (`https://github.com@evil.com` is evil.com). All 37 host
        cases are in tests/xss-fixtures.json.
     b. `img` stays OUT of the sanitiser's allowlist, and no src from input is
        ever assigned to an img element. The renderer emits an inert PLACEHOLDER;
        the post-pass over the fragment WE own creates the <img> and sets only
        attributes we choose. An img node therefore never exists with an unvetted
        src — which matters because setting src starts the fetch immediately.
     c. what gets used is the NORMALISED href the parser returned, not the
        original string, so the browser cannot resolve it differently from the
        check (the check-then-use mismatch class).

   HONEST LIMITATION: a trusted host can 302 anywhere, and markup cannot see it.
   The allowlist bounds who we ASK, not who ultimately answers. Mitigated only
   partly, by referrerpolicy=no-referrer and by carrying no credentials.

   Raw `<img>` TAGS in HTML are still dropped (the allowlist has no img), so only
   markdown `![alt](url)` can produce an image. Measured against the live
   snapshot: 44 markdown images across 17 records, all from developer.mend.io
   (Renovate badges — untrusted, so still links), and zero raw <img> tags. If raw
   tags start appearing they need their own pass.
   ------------------------------------------------------------------------ */

import { Marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

/* Schemes a link may use. Everything else — javascript:, data:, vbscript:,
   file:, blob:, and any unknown scheme — is dropped, not "escaped". */
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

/* A relative or fragment target is harmless and stays as text-only (no href):
   the panel has no routes, so a relative link cannot mean anything useful. */
function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control characters and whitespace FIRST: "java\tscript:alert(1)" and
  // "\u0001javascript:..." are the classic ways past a naive prefix test.
  const cleaned = raw.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\ufeff]/g, '');
  if (!cleaned) return null;
  return SAFE_SCHEME.test(cleaned) ? cleaned : null;
}

/* Hosts whose images may load. `github.com` covers the modern upload form
   (`/user-attachments/assets/…`); the githubusercontent.com wildcard covers raw,
   user-images, avatars, objects (release assets and LFS) and camo (GitHub's own
   image proxy, the privacy-preserving case by construction). All in scope
   deliberately: each is GitHub serving content GitHub already knows the operator can
   see. https only, default port only. */
function trustedImageHost(host) {
  return host === 'github.com' || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

/** The NORMALISED https URL when this image source is trusted, else null. */
function trustedImageUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    // A sentinel base, NOT the panel's origin: "//evil.com/x" and "/x.png" must
    // resolve somewhere that can never be trusted, rather than inheriting
    // whatever origin this panel happens to run on.
    u = new URL(raw, 'https://invalid.invalid/');
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) {
    // `github.com.` is the same DNS name, so it is trusted — but CANONICALISE it
    // away rather than passing it on, so every URL this function returns has a
    // host that is literally in the trusted set. That keeps any later check
    // (including the gate's independent one) from having to know the trick.
    host = host.slice(0, -1);
    u.hostname = host;
  }
  return trustedImageHost(host) ? u.href : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* The tags a GitHub body legitimately uses, and nothing else. <details>,
   <summary>, <sup> and <kbd> are here because real issue bodies in this very
   snapshot use them; every one of them is inert. */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span',
  'strong', 'b', 'em', 'i', 'del', 's', 'sup', 'sub', 'kbd', 'mark',
  'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'details', 'summary',
];

/* No event handlers, no target (the post-pass sets it so input cannot choose
   it), no style, no id (an injected id can clobber window properties), and NO
   class — an input-chosen class could impersonate this panel's own UI.

   MEASURED SURPRISE, worth keeping written down: with a restrictive
   ALLOWED_URI_REGEXP, DOMPurify requires every attribute OUTSIDE its URI-safe
   NAME list to have a value matching that regexp (read it in
   `_isValidAttribute`). So `data-img-src="https://…"` survived while
   `data-md="img-dropped"` was silently dropped for being plain text — which had
   quietly disabled the dropped-link/dropped-image styling. ADD_URI_SAFE_ATTR
   exempts a NAME from the value check; `data-md` is only ever a CSS hook, never
   a URL, so exempting it is accurate rather than a loosening. The image's alt
   text does not need the exemption: it rides as the placeholder's TEXT, which no
   attribute policy can touch. */
const ALLOWED_ATTR = ['href', 'title', 'lang', 'dir', 'align', 'colspan', 'rowspan', 'start',
  'data-md', 'data-img-src'];

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ADD_URI_SAFE_ATTR: ['data-md'],
  ALLOWED_URI_REGEXP: SAFE_SCHEME,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
    'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'svg',
    'math', 'img', 'video', 'audio', 'source', 'track', 'canvas', 'template',
    'noscript', 'frame', 'frameset', 'applet', 'marquee', 'portal'],
  FORBID_ATTR: ['style', 'srcset', 'src', 'target', 'formaction', 'action',
    'xlink:href', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus',
    'onanimationstart', 'onbegin', 'ping', 'background', 'dynsrc', 'lowsrc'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  SAFE_FOR_TEMPLATES: false,
  RETURN_DOM_FRAGMENT: true,
  RETURN_DOM_IMPORT: false,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
  WHOLE_DOCUMENT: false,
  IN_PLACE: false,
};

const md = new Marked({ gfm: true, breaks: false, pedantic: false });

/* Renderer overrides. These run BEFORE any DOM exists, so a hostile URL never
   reaches a node at all. */
md.use({
  renderer: {
    /* Images: a trusted host gets a real <img>, built later by the post-pass;
       anything else keeps 7l's behaviour (a link for other http(s), inert text
       otherwise). What is emitted here is a PLACEHOLDER, never an img tag — see
       property (b) in the header. */
    image({ href, title, text }) {
      const label = escapeHtml(text || title || 'image');
      const trusted = trustedImageUrl(href);
      if (trusted) {
        // The alt text travels as the placeholder's TEXT, not an attribute: see
        // the note on ALLOWED_ATTR. data-img-src survives because its value is an
        // https URL, and it is re-validated before an <img> is built from it.
        return (
          '<span data-img-src="' + escapeHtml(trusted) + '"' +
          (title ? ' title="' + escapeHtml(title) + '"' : '') +
          '>' + label + '</span>'
        );
      }
      const safe = safeHref(href);
      if (!safe) return `<span data-md="img-dropped">${label}</span>`;
      return `<a href="${escapeHtml(safe)}" title="${escapeHtml(title || 'image from an untrusted host — not loaded automatically')}">${label}</a>`;
    },
    link({ href, title, tokens }) {
      const safe = safeHref(href);
      const inner = this.parser.parseInline(tokens);
      // A dropped scheme keeps the human-readable text and loses the link,
      // which is the honest outcome: the reader still sees what was written.
      if (!safe) return `<span data-md="link-dropped">${inner}</span>`;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(safe)}"${t}>${inner}</a>`;
    },
  },
});

/* ---------------------------------------------------------------- cache ---
   Keyed by caller-supplied id (record key + field) PLUS a hash of the text,
   so a record whose body changes re-renders and one that merely re-opens does
   not. The cache holds a DETACHED container and every caller gets a CLONE:
   handing out the node itself would move it out of the cache on append.
   Bounded, because a long-lived panel must not grow without limit. */
const CACHE = new Map();
const CACHE_MAX = 240;

function hash32(s) {
  // FNV-1a. Not a security primitive — it only has to notice edits.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function finishAnchors(root) {
  for (const a of root.querySelectorAll('a')) {
    const safe = safeHref(a.getAttribute('href'));
    if (!safe) {
      // Belt to DOMPurify's braces: degrade to text rather than leave a live
      // attribute nobody vetted.
      const span = document.createElement('span');
      span.dataset.md = 'link-dropped';
      while (a.firstChild) span.appendChild(a.firstChild);
      a.replaceWith(span);
      continue;
    }
    a.setAttribute('href', safe);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  // Nothing in a rendered body may carry an inline style, an id or a class it
  // chose for itself.
  for (const n of root.querySelectorAll('[style],[id],[class]')) {
    n.removeAttribute('style');
    n.removeAttribute('id');
    n.removeAttribute('class');
  }
  return root;
}

/** Phase 7m: turn vetted placeholders into real images. This is the ONLY place
    an <img> is created, and its src is re-derived from the placeholder through
    trustedImageUrl again — cheap, and it means a placeholder that somehow
    arrived by another route (raw HTML carrying data-img-src) is still checked. */
function buildImages(root) {
  for (const ph of root.querySelectorAll('span[data-img-src]')) {
    const src = trustedImageUrl(ph.getAttribute('data-img-src'));
    const alt = (ph.textContent || '').trim();
    if (!src) {
      const span = document.createElement('span');
      span.dataset.md = 'img-dropped';
      span.textContent = alt || 'image';
      ph.replaceWith(span);
      continue;
    }
    const img = document.createElement('img');
    img.className = 'md-img';
    img.alt = alt; // preserved; an empty alt stays empty, correct for decoration
    img.loading = 'lazy'; // a quick view can hold several; none of them are urgent
    img.decoding = 'async';
    // no-referrer: the host does not need to know which panel asked. There is no
    // hotlink protection to satisfy here, and GitHub serves these without it.
    img.referrerPolicy = 'no-referrer';
    if (ph.getAttribute('title')) img.title = ph.getAttribute('title');
    img.src = src; // last: everything else is set before the fetch starts
    ph.replaceWith(img);
  }
  return root;
}

/** A broken image must not leave a jagged hole, so it degrades to its alt text.
    This is attached to the CLONE the caller receives, never to the cached node:
    cloneNode does not copy listeners, so attaching it at build time would work
    once and then silently stop working for every cache hit. */
function attachImageFallbacks(root) {
  for (const img of root.querySelectorAll('img.md-img')) {
    img.addEventListener(
      'error',
      () => {
        const span = document.createElement('span');
        span.dataset.md = 'img-broken';
        const alt = img.getAttribute('alt');
        span.textContent = alt ? alt + ' (image did not load)' : 'image did not load';
        img.replaceWith(span);
      },
      { once: true },
    );
  }
  return root;
}

function build(text, { inline }) {
  const html = inline ? md.parseInline(String(text)) : md.parse(String(text));
  const fragment = DOMPurify.sanitize(html, PURIFY_CONFIG);
  const box = document.createElement('div');
  box.className = 'md';
  box.appendChild(fragment);
  // Order matters only in that both run before the caller sees the node: anchors
  // first (it strips classes input chose), then images (it sets ones we chose).
  finishAnchors(box);
  return buildImages(box);
}

/** Render markdown to a detached <div class="md">. Cached; callers get clones.
    `id` should identify the field (e.g. "owner/repo#123:body"). */
function render(id, text, opts = {}) {
  const src = text == null ? '' : String(text);
  const key = `${id}|${opts.inline ? 'i' : 'b'}|${src.length}|${hash32(src)}`;
  let box = CACHE.get(key);
  if (!box) {
    box = build(src, { inline: !!opts.inline });
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, box);
  } else {
    // Refresh recency for the bounded-map eviction order.
    CACHE.delete(key);
    CACHE.set(key, box);
  }
  return attachImageFallbacks(box.cloneNode(true));
}

/** Replace a host element's children with rendered markdown. */
function into(host, id, text, opts) {
  host.textContent = '';
  host.appendChild(render(id, text, opts));
  return host;
}

export default { render, into, safeHref, stats: () => ({ cached: CACHE.size, max: CACHE_MAX }) };
export { render, into, safeHref };

/* The bundle is spliced into the panel as a CLASSIC script, so publish the API
   on the global explicitly. esbuild's --global-name is not available in this
   environment's wrapper, and an explicit assignment is clearer anyway: exactly
   one global, named, with nothing else escaping the iife. */
globalThis.GHMarkdown = { render, into, safeHref, stats: () => ({ cached: CACHE.size, max: CACHE_MAX }) };
