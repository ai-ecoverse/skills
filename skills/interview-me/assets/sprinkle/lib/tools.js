// tools.js
// Builds the `tools` array and the `instructions` string for session.update.
// Two knowledge-base paths (see README.md — file_search is now the DEFAULT
// per BRIEF.md's addendum, now that collections can be created with a
// standard API key):
//   - file_search (DEFAULT): a pre-populated xAI Collection, vector_store_ids
//   - local-context (fallback, kbMode:"local"): lookup_documents function
//     tool + BM25-ranked excerpts injected into instructions — still the
//     right behavior for a fresh install with zero credentials.
// Web/X search need no extra credentials either way — just list them.

import { LOOKUP_DOCUMENTS_TOOL } from "./kb.js";

export function buildTools(options = {}) {
  const tools = [];

  if (options.kbMode !== "local") {
    // No baked-in fallback collection is shipped -- pointing every
    // installation at one account's private collection by default would be
    // a real privacy bug, not a convenience. Fail clearly here rather than
    // silently sending `vector_store_ids: [undefined]` to the API. The
    // primary place this should already be caught is the setup-screen
    // validation in interview-me.shtml (before a token is even minted);
    // this is the defensive backstop for any other call site.
    if (!options.collectionId) {
      throw new Error(
        "No collection configured for file_search mode. Run the CLI's " +
          "`collections create <name>` then `set collection=<id>`, or " +
          "switch Knowledge Base mode to Local."
      );
    }
    tools.push({
      type: "file_search",
      vector_store_ids: [options.collectionId],
      max_num_results: 10,
    });
  } else {
    tools.push(LOOKUP_DOCUMENTS_TOOL);
  }

  if (options.webSearch) {
    const tool = { type: "web_search" };
    if (options.webAllowedDomains && options.webAllowedDomains.length) {
      tool.allowed_domains = options.webAllowedDomains.slice(0, 5);
    }
    tools.push(tool);
  }

  if (options.xSearch) {
    const tool = { type: "x_search" };
    if (options.xAllowedHandles && options.xAllowedHandles.length) {
      tool.allowed_x_handles = options.xAllowedHandles.slice(0, 20);
    }
    tools.push(tool);
  }

  return tools;
}

/** Fixed section order per the xAI prompting guide / BRIEF.md — keep it short. */
export function buildInstructions({ topic, sourceMaterial } = {}) {
  const t = topic && topic.trim() ? topic.trim() : "their work and interests";
  let prompt = `You are an interviewer.
## Goal
Interview the user about ${t} in under five minutes. Ask up to five questions, one at a time. Never ask two questions in one turn.
## Style
Warm, curious, concise. One or two sentences per turn. Follow up on what is actually interesting in their answer rather than marching through a list.
## Grounding
Use the source material below and your search tools to ask INFORMED, specific questions. Reference concrete details. Never invent a fact about the user.
## Wrap-up
When told time is nearly up, thank them and stop asking questions.`;

  if (sourceMaterial && sourceMaterial.trim()) {
    prompt += `\n## Source material\n${sourceMaterial.trim()}`;
  }
  return prompt;
}

/** Full session.update payload per BRIEF.md's verified config. */
export function buildSessionConfig({ voice, instructions, tools, replace } = {}) {
  const session = {
    voice: voice || "eve",
    instructions,
    turn_detection: {
      type: "server_vad",
      threshold: 0.85,
      silence_duration_ms: 900,
      prefix_padding_ms: 333,
      idle_timeout_ms: 8000,
    },
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "grok-transcribe" },
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
      },
    },
    tools: tools || [],
  };
  if (replace) session.replace = replace;
  return session;
}
