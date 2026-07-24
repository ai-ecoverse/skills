---
name: elevenlabs
description: Text-to-speech, speech-to-text, and the raw ElevenLabs API from the command line. Use when the user wants realistic AI voices, to speak/read text aloud with a specific voice, generate voiceovers or narration, list or pick ElevenLabs voices, transcribe an audio or video file to text (with word timestamps or speaker diarization), or call any ElevenLabs API endpoint. Provides `eleven` (raw API + convenience), `say-11` (an ElevenLabs-backed drop-in for the built-in `say`), and `hear-11` (Scribe speech-to-text, a file-based counterpart to `hear`). Triggers on "ElevenLabs", "text to speech", "TTS", "read this aloud", "say this in <voice>", "voiceover", "narration", "clone a voice", "transcribe", "speech to text", "STT", "Scribe".
metadata:
  tags: elevenlabs, tts, text-to-speech, stt, speech-to-text, voice, audio, transcription, scribe
allowed-tools: bash
---

# ElevenLabs

Three commands, backed by the ElevenLabs API:

- **`eleven`** — raw API client + convenience subcommands (voices, models, tts, stt, api passthrough).
- **`say-11`** — speak text aloud (or to a file) with an ElevenLabs voice. Drop-in for the built-in `say`.
- **`hear-11`** — transcribe an audio/video **file** with ElevenLabs Scribe. File-based counterpart to `hear`.

## Setup (API key)

Store the key once — it is saved in the skill's `scripts/.config` (git-ignored; never commit it):

```bash
eleven auth <your-key>      # or: export ELEVENLABS_API_KEY=<key>, or pass --key <key>
eleven auth --show          # verify (masked)
```

Auth priority for every command: `--key` flag → `ELEVENLABS_API_KEY` env → stored config.

Note: API keys are scoped. A key without the `user_read` permission will 401 on `eleven user`
but still work for TTS/STT/voices — that's expected.

## say-11 — speak text (replaces `say`)

Same interface as the built-in `say`:

```bash
say-11 "Hello there"                     # synthesize + play aloud (default voice: Rachel)
say-11 -v Sarah "Reading in Sarah's voice"   # -v = voice name (partial match) or voice_id
say-11 -o out.mp3 "Save instead of play"     # -o writes MP3 to a file
say-11 -r 1.25 "A little faster"             # -r playback rate (applied via afplay)
say-11 -m eleven_turbo_v2_5 "Low latency"    # -m model id
say-11 --list                                # list voices
```

Output is MP3 (ElevenLabs' native format). On success it plays and prints nothing to stdout
(a short byte note goes to stderr), matching `say`'s quiet behavior.

## hear-11 — transcribe a file (Scribe STT)

```bash
hear-11 recording.mp3                     # prints the transcript
hear-11 -i recording.m4a -l en            # -i file, -l language hint (ISO 639)
hear-11 clip.mp4 --words                  # word-level timestamps
hear-11 meeting.mp3 --diarize             # label speakers (speaker_0, speaker_1, …)
hear-11 clip.wav --json                   # full JSON (words, timings, speakers)
```

**Does NOT record the microphone** — ElevenLabs STT needs a file. For live mic input use the
built-in `hear`, then transcribe the resulting file here.

## eleven — raw API + convenience

```bash
eleven voices [--search rachel] [--json]  # list / filter voices
eleven models [--json]                    # list TTS models
eleven tts "text" [--voice v] [--model m] [--out f] [--format fmt] [--play]
eleven stt <file> [--lang xx] [--diarize] [--num-speakers n] [--json]
eleven user                               # subscription (needs user_read scope)
eleven config [--voice <id|name>] [--model <id>] [--stability n] [--similarity n] [--style n]  # per-user defaults
eleven api <METHOD> <path> [--data '<json>'] [--query k=v] [--out <file>]   # any endpoint
```

Examples:

```bash
# Binary responses (e.g. text-to-speech audio) are written to a file, not printed:
eleven api POST /text-to-speech/21m00Tcm4TlvDq8ikWAM --data '{"text":"hi","model_id":"eleven_multilingual_v2"}' --out /tmp/hi.mp3

eleven api GET /voices/settings/default
eleven api POST /text-to-speech/21m00Tcm4TlvDq8ikWAM --data '{"text":"hi","model_id":"eleven_multilingual_v2"}'
eleven config --voice "George" --model eleven_multilingual_v2   # persist defaults
```

## Defaults

- Voice: `21m00Tcm4TlvDq8ikWAM` (Rachel) unless overridden or set via `eleven config --voice`.
- Voice settings (stability / similarity_boost / style, each 0–1) can be tuned per call
  (`say-11 --stability 0.3 --style 0.4 --similarity 0.9`) or persisted per user via `eleven config`.
  Lower stability = more expressive/variable; higher similarity = closer to the source voice;
  higher style = more expressive delivery. These are personal settings in `.config`, not skill defaults.
- TTS model: `eleven_multilingual_v2` (auto-detects language). Alternatives: `eleven_turbo_v2_5`
  / `eleven_flash_v2_5` (low latency), `eleven_v3` (newest).
- STT model: `scribe_v1`.

## Notes / gotchas

- The key is stored in `scripts/.config` (git-ignored). Rotate with `eleven auth <newkey>`.
- TTS returns binary audio; the tools fetch it and write faithful MP3 via the VFS binary bridge.
- STT uploads a multipart file via `curl` (the proxied `fetch` cannot send binary bodies).
- `-v`, `-o`, `-r`, `-l`, `-i`, `-m` are single-dash value flags — the tools hand-parse argv
  because the runtime's `parseFlags()` treats single-dash flags as booleans.
- Playback uses the built-in `afplay`; `say-11 -o file` skips playback and just writes the file.
