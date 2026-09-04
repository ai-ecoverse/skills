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

// Session length is configurable (config.json's `sessionMinutes`, bounds
// 1-10 — see interview-me.shtml's MIN/MAX_SESSION_MINUTES), so the prompt
// cannot state a fixed one: a 10-minute interview instructed to finish "in
// under five minutes" is actively mis-steered, and a 1-minute one is told it
// has five times the time it really has. BOTH duration-derived literals in
// the Goal section — the length and the question budget — are therefore
// computed from the length actually in effect for this session, which the
// host passes in from the same snapshot its countdown and WrapupController
// use (interview-me.shtml's state.sessionLengthMs).
const DEFAULT_SESSION_MINUTES = 5; // only for a missing/unusable value — matches the host's own fallback

/** Same "5" vs "2.5" formatting the Setup screen's copy uses (interview-me.shtml's updateSetupIntro). */
function minutesLabel(minutes) {
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/**
 * One question per minute, floored at 2 — the ratio the verified 5-minute
 * prompt already used ("up to five questions" in five minutes), so a
 * 5-minute session's prompt is unchanged and every other length scales from
 * it. The floor matters at the 1-minute bound: this is a ceiling the model
 * must not exceed, not a target, and one question with no room for a single
 * follow-up is not an interview.
 */
function questionBudget(minutes) {
  return Math.max(2, Math.round(minutes));
}

/** Fixed section order per the xAI prompting guide / BRIEF.md — keep it short. */
export function buildInstructions({ topic, sourceMaterial, sessionMinutes } = {}) {
  const t = topic && topic.trim() ? topic.trim() : "their work and interests";
  const rawMinutes = Number(sessionMinutes);
  const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : DEFAULT_SESSION_MINUTES;
  const duration = `${minutesLabel(minutes)} minute${minutes === 1 ? "" : "s"}`;
  let prompt = `You are an interviewer.
## Goal
Interview the user about ${t} in under ${duration}. Ask up to ${questionBudget(minutes)} questions, one at a time. Never ask two questions in one turn.
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
