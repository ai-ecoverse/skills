// ranker.js
// Minimal, dependency-free local document ranking for the default
// "local-context" knowledge-base path (see BRIEF.md / README.md): chunk
// markdown/text files, score chunks against a query with BM25, and build a
// character-budgeted excerpt block for injection into session instructions.

const DEFAULT_CHUNK_CHARS = 900;
const DEFAULT_CHUNK_OVERLAP = 150;
const K1 = 1.5;
const B = 0.75;

/** Split one document's text into overlapping chunks. */
export function chunkText(text, filename, chunkChars = DEFAULT_CHUNK_CHARS, overlap = DEFAULT_CHUNK_OVERLAP) {
  const chunks = [];
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return chunks;

  let start = 0;
  let index = 0;
  while (start < clean.length) {
    const end = Math.min(start + chunkChars, clean.length);
    chunks.push({ filename, index, text: clean.slice(start, end) });
    index += 1;
    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** Build the BM25 corpus (term frequencies, doc frequencies, lengths) once. */
export function buildCorpus(files) {
  const chunks = [];
  for (const f of files || []) {
    chunks.push(...chunkText(f.text, f.filename));
  }

  const docTokens = chunks.map((c) => tokenize(c.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgLength = docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1) || 1;

  const df = new Map();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }

  return { chunks, docTokens, docLengths, avgLength, df, N: chunks.length };
}

/** Rank chunks against `query` with BM25; falls back to document order if the query is empty. */
export function rankChunks(corpus, query, topN = 6) {
  const { chunks, docTokens, docLengths, avgLength, df, N } = corpus;
  if (!N) return [];

  const qTokens = tokenize(query);
  if (!qTokens.length) {
    return chunks.slice(0, topN).map((c) => ({ ...c, score: 0 }));
  }

  const qTerms = new Set(qTokens);
  const scored = chunks.map((chunk, i) => {
    const tokens = docTokens[i];
    const length = docLengths[i] || 1;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const term of qTerms) {
      const freq = tf.get(term) || 0;
      if (!freq) continue;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const denom = freq + K1 * (1 - B + (B * length) / avgLength);
      score += idf * ((freq * (K1 + 1)) / denom);
    }
    return { ...chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/** Join ranked chunks into a labelled excerpt block within a hard character budget. */
export function buildSourceMaterial(rankedChunks, budgetChars = 12000) {
  let used = 0;
  const parts = [];
  for (const chunk of rankedChunks || []) {
    const label = `### ${chunk.filename} (excerpt ${chunk.index + 1})\n`;
    const body = chunk.text.trim();
    const entry = `${label}${body}\n`;

    if (used + entry.length > budgetChars) {
      const remaining = budgetChars - used - label.length - 1;
      if (remaining > 200) {
        parts.push(`${label}${body.slice(0, remaining)}…\n`);
      }
      break;
    }
    parts.push(entry);
    used += entry.length;
  }
  return parts.join("\n");
}
