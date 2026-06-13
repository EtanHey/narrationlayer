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
- Each job is stored under `<data-dir>/jobs/<job-id>/` with:
  - `job.json`
  - `status.json`
  - `manifest.json`
  - `DONE` or `FAILED`

## Install

```bash
bun install
```

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

Use `--json` with `doctor`, `create-job`, `render`, `bakeoff-create`,
`qwen3-lora-prepare`, and `qwen3-lora-preflight` for machine-readable stdout.
`status`, `result`, `dashboard`, and `list-jobs` always emit JSON.

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
changing whether playback is currently playing or paused.

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
- `src/renderers/voicelayer-qwen3.ts` — local VoiceLayer/Qwen3 HTTP adapter
- `src/renderers/external-command.ts` — configurable local runner adapter
- `src/renderers/types.ts` — shared renderer interface
- `src/qwen3-lora.ts` — Qwen3 LoRA dataset preparation and preflight helpers
- `src/schema.ts` — schema and validation helpers
- `src/contract.ts` — shared MCP tool contract
- `src/service.ts` — shared CLI/MCP job lifecycle
