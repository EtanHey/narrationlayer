# Teleprompter Contract

Teleprompter playback should consume a per-segment `words.json` file and highlight
without requiring full transcript scans.

Current fields in a segment `words.json`:

- `job_id`
- `segment_id`
- `words[]`
  - `index`
  - `word`
  - `start_seconds`
  - `end_seconds`

## V0 behavior

`fake` renderer emits estimated word boundaries per segment duration. This keeps
playable highlight behavior for local smoke tests and UI validation.

## Forward path

Replace `fake` timings by forced-aligner backends:

- WhisperX
- Gentle
- Montreal Forced Aligner

The rest of the contract stays stable because:

1. segment contract (`audio_path`, `words_path`) is constant
2. manifest and job surfaces are renderer-agnostic
3. `words.json` schema is renderer-agnostic
