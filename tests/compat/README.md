# Executable and job characterization

These goldens describe the existing runner and service, without production changes.
All voice inputs are generated tones and public synthetic text. Nothing is played.
Bun, ffmpeg and ffprobe must be on PATH; missing dependencies fail explicitly.

- Run: `bun test tests/compat`
- Regenerate the eight generated `fixtures/*.golden.json` files:
  `UPDATE_COMPAT_GOLDENS=1 bun test tests/compat`
- Prove sensitivity: `bun tests/compat/mutations.ts`. This sequential command
  temporarily mutates production files, restores them in `finally`, and checks
  FAIL then PASS for each mutation. Do not run other tests concurrently with it.
  Logs go to ignored `docs.local/characterization/`.

The HTTP stub returns deterministic 24 kHz mono PCM WAV to the runner. For the
job path it encodes that same tone to MP3 using real ffmpeg, because the current
MP3 assembly stage uses stream copy. No audio processing is mocked. Only
`VoiceLayerQwen3Config.word_timing_provider` substitutes synthetic uniform word
alignment for Whisper; subsequent word repair and persisted words remain real.

The harness contains the canonicalization table. Fixture paths and wall-clock
fields vary; the ephemeral HTTP origin also needs a stable name. Application
headers (content type and authorization) are frozen; transport-generated Host
and Content-Length are checked against each actual request. Provenance is pinned
through `narrationlayer_commit`, and storage through `NARRATIONLAYER_DATA_DIR`.
The runner's real path-dependent cache hash is asserted against an independently
constructed preimage; the golden then stores that preimage with canonical paths
and its hash. No arbitrary cache key or commit is masked.

Wrappers log argv actually executed by the runner, then run the real tools.
The current runner invokes ffmpeg but never ffprobe: that empty trace is asserted.
Output format is separately checked with real ffprobe. The named-profile golden
covers the env-file profile; a separate invocation unsets that variable and
requires the root example's qwen3-voice missing-clip failure as a directory
sentinel. The two-daemon case checks flag/profile precedence with distinct tokens.

Known baseline defects are deliberately preserved: failed attempts retain a
pre-existing output WAV; a failure during breathing can retain the initial full
take. HTTP failures call `process.exit`, bypassing intermediate-file cleanup;
abort exceptions do run cleanup. Receipts are removed before a new attempt.
The cleanup mutation leaves a breathing intermediate WAV after an abort and must
fail its executable test. Fixing stale final output needs a separate change.
