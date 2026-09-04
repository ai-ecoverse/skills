// realtime-session.js
// Thin protocol layer over the xAI Speech-to-Speech realtime WebSocket. Only
// knows xAI's event names and shapes (see docs/speech-to-speech.md) — no
// audio decoding, no UI, no knowledge base. Wire behavior in via the on*
// hooks. Event-name gotchas this file encodes on purpose:
//   - user transcript event is `.updated` (cumulative), NOT `.delta`
//   - `conversation.item.done` and `rate_limits.updated` are never emitted
//   - tool calls arrive at/after `response.done`, after all audio deltas

export const REALTIME_URL = "wss://api.x.ai/v1/realtime";
export const DEFAULT_MODEL = "grok-voice-latest";

export class RealtimeSession {
  constructor({ model = DEFAULT_MODEL, localFunctionNames = [] } = {}) {
    this.model = model;
    this.ws = null;
    this.conversationId = null;

    // Hooks — assign whichever you need from the caller.
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onSessionUpdated = null;
    this.onSpeechStarted = null;
    this.onSpeechStopped = null;
    this.onUserTranscriptUpdated = null; // (itemId, cumulativeText)
    this.onAssistantTranscriptDelta = null; // (itemId, delta, responseId)
    this.onAssistantTranscriptDone = null; // (itemId, transcript)
    this.onAudioDelta = null; // (base64, itemId, responseId)
    this.onFunctionCall = null; // async ({name, callId, arguments}) -> output (string|object) -- ONLY ever called for a name in _localFunctionNames, see isLocalFunction()
    this.onServerToolCall = null; // ({name, callId, arguments}) — fires for a SERVER-SIDE tool call (any function_call name NOT in _localFunctionNames: file_search/collections_search, web_search, x_search, mcp, etc). Informational only: no return value is used, no function_call_output is ever sent for these, and _inFlightCalls/onToolCallsSettled are never touched by them — the server continues that response on its own; see response.function_call_arguments.done handling below for why replying at all was the root cause of a real bug (duplicate/truncated assistant turns, lost user answers).
    this.onResponseCreated = null; // (event) — response.created; pairs with onResponseDone via event.response.id
    this.onResponseDone = null; // (event)
    this.onRawEvent = null; // (event) — fires for every parsed event; useful for debugging/logging

    // Tool calls can arrive in parallel; only tell the caller it is safe to
    // send response.create once every in-flight call for this turn has had
    // its function_call_output sent (see "Avoid Audio Overlap" in
    // docs/speech-to-speech.md). The caller still owns waiting for local
    // audio playback to drain before actually calling requestResponse().
    // Only ever incremented for a LOCAL function call — see
    // isLocalFunction() and the response.function_call_arguments.done
    // case below.
    this.onToolCallsSettled = null; // () — fires when in-flight tool calls return to zero
    this._inFlightCalls = 0;

    this.setLocalFunctionNames(localFunctionNames);
  }

  /**
   * The set of function-call `name`s this CLIENT declared as `type:
   * "function"` tools in session.tools (see tools.js's buildTools() --
   * today just `lookup_documents`, and only in local-KB mode). Anything
   * else that arrives via response.function_call_arguments.done is a
   * SERVER-SIDE tool (file_search — which arrives under the name
   * `collections_search`, not `file_search` — web_search, x_search, mcp,
   * etc): the server executes those and continues the response itself,
   * so replying with a function_call_output (let alone an unsolicited
   * response.create once every "in-flight" call appears settled) both
   * lies to the model about its own tool ("Unknown function") and
   * pre-empts a response the server is already generating on its own.
   *
   * Real, verified failure chain from this exact bug: the server's own
   * file_search call arrives as `collections_search` -> previously
   * treated as unknown/ours -> client sent a bogus function_call_output
   * -> client's _inFlightCalls hit 0 -> onToolCallsSettled fired -> an
   * unsolicited response.create pre-empted the user's own in-flight
   * speech turn (their answer was never committed/transcribed) and made
   * the model regenerate/duplicate its previous turn (the truncated
   * re-emission a prior fix already merges as a belt-and-braces measure,
   * but this is the actual root cause).
   *
   * Deliberately an ALLOW-list (what IS ours), not a deny-list of known
   * server-tool names — xAI can add server-side tools without this file
   * ever needing to know their names; only the caller (which knows what
   * it declared in session.tools) needs to keep this in sync, via the
   * constructor option or this setter.
   *
   * @param {string[]} names
   */
  setLocalFunctionNames(names) {
    this._localFunctionNames = new Set(Array.isArray(names) ? names : []);
  }

  isLocalFunction(name) {
    return this._localFunctionNames.has(name);
  }

  connect(ephemeralToken) {
    return new Promise((resolve, reject) => {
      const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
      let ws;
      try {
        ws = new WebSocket(url, [`xai-client-secret.${ephemeralToken}`]);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;

      const onOpen = () => {
        if (this.onOpen) this.onOpen();
        resolve();
      };
      const onError = (err) => {
        if (this.onError) this.onError(err);
        reject(err);
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", (event) => {
        if (this.onClose) this.onClose(event);
      });
      ws.addEventListener("message", (event) => this._handleMessage(event));
    });
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  _send(obj) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  updateSession(sessionPatch) {
    return this._send({ type: "session.update", session: sessionPatch });
  }

  appendAudio(base64Pcm16) {
    return this._send({ type: "input_audio_buffer.append", audio: base64Pcm16 });
  }

  sendFunctionCallOutput(callId, output) {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    return this._send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: text },
    });
  }

  requestResponse(instructionsOverride) {
    const response = instructionsOverride ? { instructions: instructionsOverride } : {};
    return this._send({ type: "response.create", response });
  }

  /** xAI extension: a hard-coded, TTS-synthesized line, e.g. the T-30s wrap-up nudge. */
  sendForceMessage(text, interruptible = true) {
    return this._send({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible,
        content: [{ type: "output_text", text }],
      },
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        /* ignore */
      }
    }
  }

  async _handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      return; // binary transport frames are not used by this client
    }
    if (this.onRawEvent) this.onRawEvent(data);

    switch (data.type) {
      case "conversation.created":
        this.conversationId = data.conversation && data.conversation.id;
        break;

      case "session.updated":
        if (this.onSessionUpdated) this.onSessionUpdated(data);
        break;

      case "input_audio_buffer.speech_started":
        if (this.onSpeechStarted) this.onSpeechStarted(data);
        break;

      case "input_audio_buffer.speech_stopped":
        if (this.onSpeechStopped) this.onSpeechStopped(data);
        break;

      // NOT `.delta` — xAI renamed this from the OpenAI event, and it is
      // CUMULATIVE. Callers must replace stored text, never append.
      case "conversation.item.input_audio_transcription.updated":
        if (this.onUserTranscriptUpdated) {
          this.onUserTranscriptUpdated(data.item_id, data.transcript || "");
        }
        break;

      case "response.output_audio_transcript.delta":
        if (this.onAssistantTranscriptDelta) {
          this.onAssistantTranscriptDelta(data.item_id, data.delta || "", data.response_id);
        }
        break;

      case "response.output_audio_transcript.done":
        if (this.onAssistantTranscriptDone) {
          this.onAssistantTranscriptDone(data.item_id, data.transcript || "");
        }
        break;

      // Both spellings appear across xAI's docs; handle either.
      case "response.audio.delta":
      case "response.output_audio.delta":
        if (this.onAudioDelta) {
          this.onAudioDelta(data.delta, data.item_id, data.response_id);
        }
        break;

      case "response.function_call_arguments.done": {
        let args = {};
        try {
          args = JSON.parse(data.arguments || "{}");
        } catch (err) {
          args = {};
        }

        // Server-side tool (see isLocalFunction()'s doc comment for the
        // full failure chain this gate fixes): surface it for visibility
        // only. Do NOT send a function_call_output, do NOT touch
        // _inFlightCalls, do NOT ever let this reach onToolCallsSettled --
        // the server is already continuing this response on its own.
        if (!this.isLocalFunction(data.name)) {
          if (this.onServerToolCall) this.onServerToolCall({ name: data.name, callId: data.call_id, arguments: args });
          break;
        }

        if (!this.onFunctionCall) break;
        this._inFlightCalls += 1;
        try {
          const output = await this.onFunctionCall({ name: data.name, callId: data.call_id, arguments: args });
          this.sendFunctionCallOutput(data.call_id, output);
        } finally {
          this._inFlightCalls -= 1;
          if (this._inFlightCalls === 0 && this.onToolCallsSettled) this.onToolCallsSettled();
        }
        break;
      }

      case "response.created":
        if (this.onResponseCreated) this.onResponseCreated(data);
        break;

      case "response.done":
        if (this.onResponseDone) this.onResponseDone(data);
        break;

      case "error":
        if (this.onError) this.onError(data.error || data);
        break;

      default:
        break;
    }
  }
}
