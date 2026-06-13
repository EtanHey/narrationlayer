# Teleprompter Contract

Teleprompter playback should consume a per-segment `words.json` file and highlight
without requiring full transcript scans.

Current fields in a segment `words.json`:

- `job_id`
- `segment_id`
- `timing`
  - `status`: `available` or `unavailable`
  - `source`: renderer name
  - `reason`: optional unavailable reason
- `words[]`
  - `index`
  - `word`
  - `start`
  - `end`
  - `confidence` (optional)

## V1 behavior

`fake` renderer emits deterministic word boundaries per segment duration. This
keeps teleprompter highlight behavior stable for local smoke tests and UI
validation.

`voicelayer-qwen3` preserves returned timings when the backend supplies them. If
the local daemon returns only audio, the adapter can optionally run
`whisper-cli` alignment from a local profile. If no timing backend is configured
or alignment fails, the words file is still written with
`timing.status = "unavailable"` and an empty `words[]` array.

The dashboard uses the same `start` values for reverse seeking: clicking a
teleprompter word sets the audio current time to that word. Seeking does not
change play/pause state.

## Forward path

Possible future timing sources:

- WhisperX
- Gentle
- Montreal Forced Aligner

The rest of the contract stays stable because:

1. segment contract (`audio_path`, `words_path`) is constant
2. manifest and job surfaces are renderer-agnostic
3. `words.json` schema is renderer-agnostic
