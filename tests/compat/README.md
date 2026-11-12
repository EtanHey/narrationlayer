# Executable and job characterization

These goldens describe the existing runner and service, without production changes.
All voice inputs are generated tones and public synthetic text. Nothing is played.
Bun, ffmpeg and ffprobe must be on PATH; missing dependencies fail explicitly.

- Run: `bun test tests/compat`
- Regenerate the eight generated `fixtures/*.golden.json` files:
  `UPDATE_COMPAT_GOLDENS=1 bun test tests/compat` (intentionally exits 1 after
  writing; re-run without the variable to verify; forbidden when CI is set)
- Prove sensitivity: `bun tests/compat/mutations.ts`. This sequential command
  temporarily mutates production files, restores them in `finally`, and checks
  FAIL then PASS for each mutation. Do not run other tests concurrently with it.
  Logs go to ignored `docs.local/characterization/`.

The HTTP stub returns deterministic 24 kHz mono PCM WAV to the runner. For the
job path it encodes that same tone to MP3 using real ffmpeg, because the current
MP3 assembly stage uses stream copy. No audio processing is mocked. Only
`VoiceLayerQwen3Config.word_timing_provider` substitutes synthetic uniform word
alignment for Whisper; subsequent word repair and persisted words remain real.

Every corpus entry runs through both direct and named-profile invocations;
requests freeze the whole take and the actual breathing pieces, including newlines.
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

Toolchain stability: the main job golden uses authored durations for stable word
times, but also freezes real silence/probe argv and the concat file order. A
separate job has no authored duration: its real probe must equal independently
probed chunks plus pauses within one MP3 frame (1152/24000 s) per audio join.
The wrappers record real loudness measurements and assert the executed gain is
`target - measured`; its golden preserves the filter structure with a measured-gain
placeholder. WAV format and cache byte equality within the same run remain checked.
Success requests use a 10-second timeout; only timeout tests use 150 ms.
Bun AbortError name/message remain frozen. Any golden regeneration after a toolchain
bump requires a stated reason and a review of the diff; never refresh only to turn
a failing test green. Timeout handlers settle on request abort. Root-profile
conflicts fail with a public diagnostic before the root-lookup assertions. The only
alignment substitution remains word_timing_provider.

Known baseline defects are deliberately preserved: failed attempts retain a
pre-existing output WAV; a failure during breathing can retain the initial full
take. HTTP failures call `process.exit`, bypassing intermediate-file cleanup;
abort exceptions do run cleanup. Receipts are removed before a new attempt.
The cleanup mutation leaves a breathing intermediate WAV after an abort and must
fail its executable test. Fixing stale final output needs a separate change.
