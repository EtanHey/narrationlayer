# Voice Cloning Recipe

This document describes a safe, local-first workflow that keeps private assets
outside git history while producing reusable voice profiles.

## 1) Choose source audio

- Pick clean source material with minimal background noise.
- Prefer read-like, neutral tone.
- Keep only public-safe placeholder files under version control.

## 2) Extract candidate reference windows

- Cut short windows (5s–30s) where pronunciation is stable.
- Track every extracted window in private local files (not committed).

## 3) Keep reference WAV and transcript private

- `profiles.local.yaml`, `reference-clips/`, `voices.local/`,
  `*.wav`, `*.flac`, `*.m4a`, `*.opus` must remain untracked.
- Use `.env` or local profiles for secrets and daemon paths.

## 4) Create a voice profile

- Configure profile with `reference_clip` + `reference_text_path` or
  `reference_clips[]` depending on toolchain support.
- Store local overrides in `profiles.local.yaml`.

## 5) Run renderer

- Start with `fake` to validate structure.
- For real runs, use the chosen backend adapter config.

## 6) Evaluate output

Assess:

- Cadence (speed / pauses)
- Seam artifacts between segments
- Tail energy drift
- WER / STT drift against the source script
- Duration tolerance vs spec
- Followability in teleprompter mode

## 7) Retry bad chunks

- Re-render only failed or low-confidence chunks.
- Keep retries in local scratch directories, not public repo files.

## 8) Stitch segments

- Merge segment-level outputs into final track only in private build folders.

## 9) Export and manifest

- Export per-segment artifacts and write manifest metadata.
- Export `words.json` when alignments are available.

## Known adapter pitfalls

- launchd may run with a different Python interpreter than expected; call the
  target interpreter explicitly.
- `mlx_audio` current APIs often expect `mlx_audio.tts.load(...)`.
- Qwen3 generation commonly yields generator chunks, not an object with
  `to_bytes`.
- Profiles may be represented as `reference_clip + reference_text_path` or
  `reference_clips[]` depending on ingestion layer.

