// HTML/entity helpers for search.jsh. Kept free of sliccy:/fs so tst can import them.

// The named entities that actually show up in search snippets; anything else is
// left verbatim rather than guessed at.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};

function decodeEntity(entity) {
  if (entity[0] === '#') {
    const code =
      entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return '';
  }
  const named = NAMED_ENTITIES[entity.toLowerCase()];
  return named === undefined ? `&${entity};` : named;
}

/** Brave descriptions carry <strong> markup and entities; keep snippets plain. */
function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return (
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, e) => decodeEntity(e))
      .replace(/\s+/g, ' ')
      // Tags become spaces, so `<strong>x</strong>, y` would leave " ,".
      .replace(/ ([,.;:!?])/g, '$1')
      .trim()
  );
}

module.exports = { decodeEntity, stripHtml };
