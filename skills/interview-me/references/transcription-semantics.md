# Transcription event semantics

## `grok-transcribe` is required, silently

`session.update`'s `audio.input.transcription.model` **must** be set to
`"grok-transcribe"`. Omit it (or set anything else) and you get **zero**
user-side transcription events — no error, no warning, just silence on
that channel while everything else (audio in/out, assistant transcript)
keeps working. This is the single most important line in the session
config for anyone building a transcript feature.

## User transcript: cumulative `.updated`, not `.delta`

User speech transcription arrives as
`conversation.item.input_audio_transcription.updated` — **not**
`.delta`. Two consequences:

1. **It is cumulative.** Each event carries the *full* transcript so far
   for that item, not an incremental chunk. Store logic must **replace**
   the stored text for that item id on every event, never append —
   appending a cumulative string to itself produces garbled, duplicated
   text.
2. **It can correct earlier text.** A later `.updated` event for the same
   item id may revise words the model corrected its own transcription of.
   Always trust the latest event's full string over anything you recorded
   earlier for that id.

`.failed` and `.segment` variants of this event are never emitted in
practice — don't build handling for them expecting they'll fire.

## Assistant transcript: incremental `.delta`, plus a `.done` re-emission quirk

Assistant speech transcription (`response.output_audio_transcript.delta`)
*is* incremental — append-as-you-go is correct there, unlike the user
side. `response.output_audio_transcript.done` carries the final text (use
it to overwrite/confirm, since delta accumulation can occasionally drift
from the true final string by a character or two).

**Re-emission under a new item id.** The server sometimes re-emits an
assistant turn's transcript under a brand-new `item_id` after tool calls
resolve — same conversational turn, same text, different id. Recorded
verbatim without accounting for this, it reads as the interviewer
repeating itself, which it did not do. Worse, the re-emission is not
always byte-identical to the original: it can be truncated mid-word
(observed: a 319-character question finalized once, then two tool calls,
then the "same" question re-emitted under a new item id but cut off at
105 characters). A transcript store needs to detect this shape — look
back across purely-tool entries (no intervening user turn) for a prior
assistant entry whose (trimmed) text is either identical to, or a prefix
of, the new one — and merge to the *longer* text under the *earlier*
item's start time, rather than recording two separate turns.

## Events that are documented elsewhere but never actually emitted

`conversation.item.done` and `rate_limits.updated` are not emitted by this
API in practice. Do not build logic that waits on either — it will hang
forever waiting for an event that isn't coming.

## Tool-call timing relative to audio

Tool-call-related events (`response.function_call_arguments.done`,
`response.done`) arrive **after** all audio deltas for that response, not
interleaved with them. If your code replies to a genuine client-side tool
call instantly upon seeing the arguments, you can get overlapping audio
from the next response. Wait for local playback to fully drain before
sending `function_call_output` + `response.create` for a client-side tool.
(This does not apply to server-side tool calls at all — see
`server-side-tool-calls.md`; those must never get a reply in the first
place.)

## A `force_message`'s transcript is not a signal of anything

A scripted `force_message` (a hard-coded TTS line sent directly, not a
model-authored turn) still fires the normal
`response.output_audio_transcript.done` lifecycle — but with an **empty**
transcript string. If you have any "did the model produce a real
response" health check (e.g. a stream-liveness watchdog looking for empty
responses as a sign of a dead connection), it needs to know about
force_message turns specifically and exclude them, or every
force_message you ever send will register as a false-positive "the stream
went dead" warning. Track which item id a force_message becomes (there is
no client-supplied id on `conversation.item.create`, so this has to be a
heuristic — "the next brand-new item id after sending it" is reasonable
given a force_message intentionally skips `response.create`, so no
concurrent response should be in flight when it lands) and record the
*actual text you sent*, not the empty transcript event, for that item.
