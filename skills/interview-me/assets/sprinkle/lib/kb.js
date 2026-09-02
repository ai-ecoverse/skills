// kb.js
// Knowledge-base glue for the DEFAULT local-context path (see README.md):
// load markdown/text files from a VFS directory, rank them locally against
// the interview topic (ranker.js), and expose both (a) the excerpt block to
// inject into `instructions` and (b) the client-side `lookup_documents`
// function-tool handler the agent can call mid-interview for more.

import { buildCorpus, rankChunks, buildSourceMaterial } from "./ranker.js";

export const LOOKUP_DOCUMENTS_TOOL = {
  type: "function",
  name: "lookup_documents",
  description:
    "Search the local knowledge-base documents for passages relevant to a query. Use this mid-interview to pull additional grounding beyond what was already provided in the source material.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search the documents for." },
    },
    required: ["query"],
  },
};

export class KnowledgeBase {
  constructor() {
    this.files = []; // [{filename, text}]
    this.corpus = null;
  }

  /**
   * @param {string} dirPath VFS directory to load .md/.txt files from
   * @param {(path:string)=>Promise<Array<{name:string,type:string}>>} readDir
   * @param {(path:string)=>Promise<string>} readFile
   */
  async loadFromDir(dirPath, readDir, readFile) {
    this.files = [];
    let entries = [];
    try {
      entries = await readDir(dirPath);
    } catch (err) {
      entries = [];
    }

    for (const entry of entries) {
      if (entry.type !== "file") continue;
      if (!/\.(md|txt)$/i.test(entry.name)) continue;
      try {
        const text = await readFile(joinPath(dirPath, entry.name));
        this.files.push({ filename: entry.name, text });
      } catch (err) {
        // Skip unreadable file; not fatal to the session.
      }
    }

    this.corpus = buildCorpus(this.files);
    return this.files;
  }

  isEmpty() {
    return !this.corpus || this.corpus.N === 0;
  }

  rank(query, topN = 6) {
    if (!this.corpus) return [];
    return rankChunks(this.corpus, query, topN);
  }

  /** The excerpt block for `## Source material` in the system prompt. */
  sourceMaterial(topic, budgetChars = 12000, topN = 8) {
    if (this.isEmpty()) return "";
    return buildSourceMaterial(this.rank(topic, topN), budgetChars);
  }

  /** Handler for the client-side lookup_documents function tool. */
  lookupDocuments(query, topN = 4, budgetChars = 3000) {
    if (this.isEmpty()) {
      return { query, results: [], note: "No local documents are loaded." };
    }
    const ranked = this.rank(query, topN);
    return {
      query,
      results: ranked.map((r) => ({
        filename: r.filename,
        excerpt_index: r.index,
        score: Math.round(r.score * 100) / 100,
      })),
      excerpts: buildSourceMaterial(ranked, budgetChars),
    };
  }
}

function joinPath(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
