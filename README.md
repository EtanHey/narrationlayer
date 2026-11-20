# NarrationLayer

NarrationLayer is a public-safe, backend-neutral narration service for agents.
It turns structured explanatory scripts into durable narrated assets with
renderer pluggability (`fake` for deterministic local smoke tests and
`voicelayer-qwen3` for an optional local VoiceLayer daemon, and
`external-command` for local model runners such as F5-TTS MLX or IndexTTS2).

It is intentionally not Theo-specific: renderer backends are adapters only, and
repo identity stays neutral.

## Storage

- Default data directory: `~/.narrationlayer`
- Override with `NARRATIONLAYER_DATA_DIR`
- Job and segment IDs must be 1–128 ASCII letters, digits, dots, underscores or
  hyphens, starting with a letter or digit. Unsafe IDs are rejected, not rewritten.
  Omitted IDs still default to a UUID for jobs and `segment-N` for segments.
- Legacy jobs with invalid job IDs (for example, `my job`) still list, but
  `status`/`result`/`render` refuse them with `Invalid job_id`. Invalid segment IDs
  (for example, `Intro (part 1)`) make `result`/`render` refuse with `Invalid segment_id`.
  Recreate affected jobs with valid job and segment IDs.
- Each job is stored under `<data-dir>/jobs/<job-id>/` with:
  - `job.json`
  - `status.json`
  - `manifest.json`
  - `DONE` or `FAILED`

## Install

```bash
bun install
```

## Library Use

The package's front door is `src/api/index.ts` (`import { renderJob } from "narrationlayer"`):
jobs, spoken-form text, the planning `Piece` and its two policies, word timing, the
local TTS runner and its take cache, and the teleprompter. Other modules are not
importable by package name, except the legacy file paths kept for existing callers.
The module map, the import rules and the tests that enforce them are in
[docs/architecture.md](docs/architecture.md).

## CLI

```bash
bun run narrationlayer doctor
bun run narrationlayer create-job <job.json>
bun run narrationlayer render <job-id>
bun run narrationlayer status <job-id>
bun run narrationlayer result <job-id>
bun run narrationlayer dashboard <job-id> --open
bun run narrationlayer bakeoff-create <bakeoff.json>
bun run narrationlayer qwen3-lora-prepare <config.json>
bun run narrationlayer qwen3-lora-preflight <run-dir>
bun run narrationlayer list-jobs
bun run narrationlayer watch <job-id>
```

`words.json` files rendered before PR #33 can fail the narration gate's COUNT
check for respelled terms because they may contain spoken tokens instead of
authored display words. Re-render the job with the current version using
`bun run narrationlayer render <job-id>` to regenerate its timing artifacts;
this invokes the job's configured renderer and replaces its output artifacts.

Use `--json` with `doctor`, `create-job`, `render`, `bakeoff-create`,
`qwen3-lora-prepare`, and `qwen3-lora-preflight` for machine-readable stdout.
`status`, `result`, `dashboard`, and `list-jobs` always emit JSON.

### Take checks for narration builds

Run `narrationlayer check-take <wav> --sent <text-file> --words <words.json> --voice <id> --pitch-ceiling <hz>` after synthesis and recognition (ffmpeg required). It prints a JSON verdict and exits 0 on pass, 1 for a failing take, or 2 for usage, input or decode errors. Supply spoken text and an array of `{word, start, end}` recognition records. The first-word screen lowercases and removes everything except ASCII letters and digits, skips leading symbol-only tokens, searches only the first three recognised tokens, accepts a word split across consecutive tokens, and matches English number words to digits in either direction (up to three tokens). This screens recognition rather than proving an acoustic omission. The build supplies each voice's pitch ceiling from that voice's controls; there is no global default. Pitch uses a dependency-free YIN difference estimator at 8 kHz, 64 ms frames, 10 ms hop, 65–450 Hz and threshold 0.2. Only full nonoverlapping one-second windows with at least ten voiced frames are judged; skipped windows have a null median. JSON reports all full windows and those above the ceiling. No judged windows fails the combined verdict. Octave and recognition errors remain possible; the build owns regeneration.

The JSON also includes `wordMatch`: a whole-take, token-level edit alignment with
zero-based sent/recognised positions, deletion/insertion/substitution evidence and
recognition times (null for a deletion, which names a boundary). Any remaining edit
fails `pass`. Empty recognition fails. This is an English/Latin-script recognition
screen; recognition can repair an audible defect and make it invisible to this check.
Setting (a), the default, tolerates case/punctuation, exact split/join groups of up to
three tokens, explicit apostrophe contractions (including is/has and would/had alternatives),
English integer words through 99 versus digits, and Levenshtein distance at most one
when both words have at least six letters. Contraction tokens are excluded from this
one-letter allowance; other apostrophe words, such as possessive names, retain it.
No missing/extra-word allowance is applied. Spelling tolerance can also hide a genuine
one-letter substitution. Every `--take-checks` attempt, including cache hits and short
takes with unjudged pitch, checks the whole spoken text with whisper-cli after pitch
acceptance; mismatches use the bounded retry loop. At the retry bound, the runner publishes the
pitch-passing take with the fewest word edits (ties keep the earliest). The receipt
records `wordMatch.keptBest: true` and each attempt's edit count; this take is never
written to the take cache, so rebuilding tries again. Pitch give-up throws only when no pitch-passing take exists; a final pitch rejection
still publishes an earlier usable best take. Non-Latin-only spoken text skips word
judging with `wordMatch.note: "not judged: no Latin-script words"`.
Recognition errors fail without a
retry or publication. This requires a Whisper model; `NARRATIONLAYER_WHISPER_BINARY`
can override the binary for all Whisper callers. Take checks pin
`~/.cache/whisper/ggml-large-v3-turbo.bin`, record its name in the receipt, and fail
with its expected path when missing; they do not use the general model fallback
or `NARRATIONLAYER_WHISPER_MODEL`. Audio bytes,
pauses and the render version are unchanged.

After recognition, every `--take-checks` attempt also checks for a cut ending
(`cutEnding` in `src/quality/take-checks.ts`): the take stopped while its last word was
still sounding. The take is decoded at 16 kHz; the audio end is the first sample of any
trailing digital silence. The check measures the 25 ms window that ends 10 ms before the
audio end against the take's speech level (the mean of the 20 ms frames within 25 dB of
the loudest). The take fails when that window is 8 dB or less under speech level, or 12 dB
or less when the last recognised word also ends within 20 ms of the audio end. A window
quieter than -45 dBFS never fails. Recognised timing alone never fails a take, because the
recogniser also stretches clean last words to the end. A word can also fade out before it is
finished ("addre" for "address"), leaving a quiet tail: the take also fails when, in its last
150 ms of sound (to the last 5 ms frame within 50 dB of speech level), a 10 ms frame reaches
within 3 dB of speech level and the level falls at 7 dB per 10 ms or faster over some 50 ms
(`fade-from-speech-level`; the receipt's `fadeDbPer10ms` is that steepest fall). A natural
decay falls slower; a stop consonant can close almost as fast, so this bar has no margin
(on the 15 Nov page it fails 9 of 465 unmarked pieces, 1.9%; on the bake-off, 1 of 1005 takes). A cut take uses the bounded retry
loop like a pitch failure and is never kept as the best word-mismatch take. The receipt's
`takeChecks.cutEnding` records the kept take's tail level. `check-take` runs the same check
on the finished take with its `--words`, through the same code (`cutTakeEnd` in
`src/quality/check-take.ts`); it needs no `--pieces`. A cut ending fails the verdict (exit 1),
and the JSON's `cutEnding` has the receipt's fields.

The same check, with the same thresholds, runs on the end of every breathing piece except
the last (`cutPieceEndings`): each piece is its own generation, so it is measured on its own
audio as joined, against its own speech level, with the recognised words whose start falls
in that piece and its pause. The runner adjusts the absolute audibility floor by the
applied output gain, so a quiet piece boosted by loudness normalization is judged at its
published level; the relative thresholds stay unchanged. A cut piece fails the take through
the same retry loop; the receipt's `takeChecks.cutJoins` lists each cut piece (number, text, measure, tail level, end
time). A cache hit renders no pieces, so its joins are recorded as not judged.

`check-take --pieces <dir>` runs the same join check on a finished take, with the same code
and thresholds (`cutJoinsInKeptPieces` in `src/quality/check-take.ts`). `<dir>` is the
runner's `--keep-pieces` directory for that take (`pieces.json` plus each piece's WAV); the
take's receipt names it as `keptPieces.dir`. A cut piece fails the verdict (exit 1), and
the JSON's `cutJoins` lists it as the receipt does. Kept pieces whose total length differs
from the take's by more than 20 ms are an input error (exit 2). Without `--pieces`,
`cutJoins.judged` is `false` and stderr says "joins not judged": the piece boundaries are
not re-found by splitting the finished take at its silences, and the verdict comes from the
other checks alone. A one-piece take has no join to judge (`piecesChecked: 0`).

`check-take --word-check-setting a|b|c|d` selects alternatives: (b) additionally
ignores jargon substitutions with character edit distance / maximum length <= 0.5;
(c) also ignores common-word substitutions unless both tokens have 4+ letters or
the recognized token is common; (d) judges only deletions and insertions. Settings
(b)/(c) require `--word-dictionary <newline-delimited-file>` (default
`/usr/share/dict/words`); a missing dictionary is an input error. Jargon means absent
from that normalized dictionary, camelCase, containing digits, or capitalized within
a sentence. These alternatives filter the same alignment; ignored substitutions stay
in `ignoredEdits`. The pipeline API accepts `takeChecks.wordCheckSetting` and, for
(b)/(c), `takeChecks.commonWords`. The page build can use `bun bin/local-tts-runner.ts --text "..." --output out.wav
--reference <profile> --take-checks --pitch-ceiling <hz> --take-retries 2
--word-check-setting a` (plus its auth/profile flags). The runner also accepts
`--word-dictionary <path>` for (b)/(c). `check-take` remains a diagnostic that exits 1
on word mismatches; runner publication uses the keep-best rule.
The page-corpus comparison did **not** meet the
15% acceptance gate for any setting; retain opt-in use pending review of its failure
rate. Setting (a) retains the greatest detection coverage, not a claim of corpus
acceptance.


## MCP

Starts a stdio MCP server in `src/mcp-server.ts` exposing:

- `create_narration_job`
- `render_narration_job`
- `get_narration_status`
- `get_narration_result`
- `list_narration_jobs`

```bash
bun run mcp-server
```

## Manifest & Teleprompter Contracts

- `schemas/narration-job.schema.json`
- `schemas/render-manifest.schema.json`
- `schemas/words.schema.json`
- `docs/mcp-tools.json`

The manifest contract includes segment artifact references (`audio_path`,
`words_path`). Each words file contains `word`, `start`, `end`, and optional
`confidence` fields plus timing availability metadata.

## Local Profiles

Public repo defaults are neutral. Copy `profiles.example.yaml` to ignored
`profiles.local.yaml` for private local voice profiles. A local profile can map a
private `voice_profile` id to `voicelayer-qwen3` without committing private
reference audio, transcripts, tokens, or cloned voice materials.
For local model bakeoffs, use `external-command` profiles that point to ignored
runner scripts and reference files outside git.

`NARRATIONLAYER_PROFILES_FILE` can point at one or more extra profile files
separated by the platform path delimiter.

For local cloned-voice dashboard demos, set `timing_backend: whisper-cli` in the
ignored profile. NarrationLayer will measure the rendered MP3 duration with local
audio tooling and use Whisper token timestamps for teleprompter word timing when
available. Set `pause_strategy: punctuation` to synthesize shorter utterances and
insert real silence at sentence and comma boundaries instead of relying on prompt
text such as bracketed pause instructions. For cloned-voice adapters, enable
`trim_silence: true` and `repair_word_timings: true` to remove long generated
tails and fall back from bad Whisper word timestamps to script-based timings.
Use a moderate `max_utterance_words` value so adjacent short sentences can stay
in one take instead of creating noisy join boundaries. The Qwen3 adapter also
rejects runaway chunks with implausible duration for the requested word count;
it retries once by default before failing the segment. Use
`max_chunk_duration_seconds`, `max_chunk_seconds_per_word`, and
`max_chunk_retries` to tune that guard for a local profile.

Qwen3 LoRA profiles can add `lora_adapter_path` and `lora_scale`. When these
fields are present, NarrationLayer forwards them to the Qwen3 daemon and fails
closed unless the daemon explicitly confirms the adapter was applied.

## Local Model Bakeoffs

`bakeoff-create` expands a shared script set into one normal NarrationLayer job
per candidate. Each candidate names a `voice_profile` and renderer, so local
Qwen3, F5-TTS MLX, IndexTTS2, VoxCPM2, or future runners can be compared through
the same manifest and dashboard contract.

The public repo only stores neutral specs and runner templates. Real voice
reference media, transcripts, LoRA adapters, model checkpoints, and command
paths belong in ignored local files.

`qwen3-lora-prepare` converts a private XTTS/Coqui-style metadata CSV
(`audio_file|text|speaker_name`) into Qwen3-TTS raw JSONL files and writes local
launcher scripts for Qwen data-code extraction and LoRA training. See
`examples/qwen3-lora-prepare.example.json`. Run `qwen3-lora-preflight` against
the generated run directory before starting training; it verifies the raw JSONL,
audio paths, 24 kHz sample rates, patched Qwen files, LoRA launcher scripts,
Python imports, and CUDA readiness.

## Dashboard Demo

`bun run narrationlayer dashboard <job-id> --open` writes a local
`dashboard.html` next to the job. It embeds the manifest and word timings, plays
the generated segment audio, and highlights teleprompter words as playback
progresses. Clicking a teleprompter word seeks the audio to that word without
changing whether playback is currently playing or paused. Re-selecting the
active section seeks rather than restarting; only a real section change reloads
the audio.

By default the audio is referenced via `file://` URLs (the dashboard is meant to
be opened directly from disk). To serve the dashboard over HTTP instead, pass
`--audio-base-url <url>` (or set `NARRATIONLAYER_AUDIO_BASE_URL`); each segment's
audio is then referenced as `<url>/<audio-filename>`.

> **The HTTP server behind `--audio-base-url` must support range requests**
> (`Accept-Ranges: bytes` / `206 Partial Content`). Without ranges the browser's
> `audio.seekable` is empty and word-click seeking / scrubbing silently do not
> work — this is the most common cause of "seeking does nothing" in a served
> dashboard. `file://` already supports seeking, so the default path is fine.

## Development

```bash
bun install
bun test
bun run typecheck
bun run narrationlayer doctor
```

## New-Machine Fake Smoke

```bash
export NARRATIONLAYER_DATA_DIR="$(mktemp -d)"
bun run narrationlayer doctor
bun run narrationlayer create-job examples/sample-job.json --json
bun run narrationlayer render <job-id> --json
bun run narrationlayer status <job-id>
bun run narrationlayer dashboard <job-id> --open
```

Expected result: `status` is `done`, `done` is `true`, `manifest_exists` is
`true`, and every rendered segment has non-empty `audio_path` and `words_path`.

For MCP, run `bun run mcp-server`. Tool names, descriptions, and input schemas
are documented in `docs/mcp-tools.json` and drift-tested against
`src/contract.ts`.

## Repository Layout

- `src/cli.ts` — CLI command implementation
- `src/mcp-server.ts` — MCP stdio server
- `src/job-store.ts` — filesystem storage helpers
- `src/renderers/fake.ts` — deterministic fake renderer for local smoke tests
- `src/renderers/voicelayer-qwen3.ts` — legacy path: re-exports the Qwen3 job renderer (`src/pipelines/job-render/`), `getWordsFromScript` (`src/timing/script-words.ts`) and its config type (`src/core/render-types.ts`); the daemon client is `src/backends/qwen3-daemon.ts`
- `src/renderers/external-command.ts` — configurable local runner adapter
- `src/renderers/types.ts` — shared renderer interface
- `src/qwen3-lora.ts` — Qwen3 LoRA dataset preparation and preflight helpers
- `src/schema.ts` — schema and validation helpers
- `src/contract.ts` — shared MCP tool contract
- `src/service.ts` — shared CLI/MCP job lifecycle
The standalone runner accepts `--take-checks --pitch-ceiling <hz>` to screen every
final take, including cache hits, for pitch runaway. `--take-retries <count>` allows
zero through ten retries after the first render (default two). Rejected takes are
never frozen or published; exhaustion exits 1 and reports attempts, failure reasons
and give-up in stderr only, preserving the previous audio and receipt. Successful receipts record render attempts and each failure
reason. Checks use their own cache key; leaving the switch off preserves existing
keys and bytes. The runner has no recognition pass, so first-word omission remains
the build's `check-take` responsibility. Each retry sends a fresh request; the daemon
supplies variance because this backend request has no seed field.


Check execution errors stop immediately without retrying or publishing audio; the runner exits 2. A failing take uses the bounded retry path and exits 1 on give-up.

A take shorter than one full second passes the runner pitch screen without retry; its receipt and output say "not judged: shorter than one window". Longer takes with no judged pitch windows still use the bounded failure path.
