# Executable and job characterization

These goldens describe the existing runner and service, without production changes.
All voice inputs are generated tones and public synthetic text. Nothing is played.
Bun, ffmpeg and ffprobe must be on PATH; missing dependencies fail explicitly.

- Run: `bun test tests/compat`
- There are sixteen `fixtures/*.golden.json` files, all frozen: the original nine
  (including `plan-pieces.golden.json`), the four defaults files, which were
  written once with
  `UPDATE_COMPAT_GOLDENS=1 bun test tests/compat/runner-defaults.test.ts tests/compat/job-defaults.test.ts`
  (intentionally exits 1 after writing; re-run without the variable to verify;
  forbidden when CI is set), and the three `runner-output-*` files, written the
  same way by `tests/compat/runner-output.test.ts`. Those three pin what the
  runner writes for each run: the output WAV's PCM format, exact sample count
  (also checked against the count its pieces, tempo and pauses imply) and RMS
  level within 0.3 dB, so they prove a stage's result reached the output file;
  they do not judge how it sounds, and pin no content hash because the hosted
  ffmpeg is unpinned. A frozen file is regenerated only when the code
  behind it changed on purpose, in this sequence:
  1. change the code;
  2. regenerate all the goldens the harness writes, with
     `UPDATE_COMPAT_GOLDENS=1 bun test tests/compat` (it exits 1 after writing),
     then run `bun test tests/compat` without the variable; that rewrites fifteen of
     the sixteen files, the keyed runner goldens included, and only those the
     change touches differ. `plan-pieces.golden.json` has no writer: if the change
     moves its rows, its test fails and the rows are edited by hand. That complete
     behaviour diff, with the reason, goes in the PR: it is the review item;
  3. run `bun test`: `tests/compat/take-cache-version.test.ts` then asks for a
     render-version raise or an attested re-record (if it asks for neither but the
     runner's cutting, pauses or ffmpeg chain changed audibly, raise anyway: the
     test sees only what the goldens record);
  4. a raise regenerates every runner golden that records a cache key or key
     preimage again (the test lists them and prints the command), and that second
     diff is key material only (the version in each key preimage and the cache keys).
  Forbidden: a regeneration with no behaviour change behind it, one that hides a
  diff (refreshing only to turn a failing test green), and a key-material
  regeneration whose diff goes beyond key material.
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
through `narrationlayer_commit`, and storage through an explicit service data-dir argument.
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
times, but also freezes real silence/probe argv and the concat file order.
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
abort exceptions do run cleanup.
The HTTP breathing intermediate is frozen as-is, so the daemon-client slice must
change it deliberately. Receipts are removed before a new attempt.
The cleanup mutation leaves a breathing intermediate WAV after an abort and must
fail its executable test. Fixing stale final output needs a separate change.

Follow-up assertions compare unauthored manifest duration with real ffprobe of
that same final file (rounded to three decimals), and named-profile final WAV
mean volume with the requested -20 dB target (within 1 dB). These measurements
bypass the PATH wrappers. The HIT sidecar is removed before each cache replay.
Auth cases use only synthetic token files, through env resolution and renderJob;
they freeze config token > config file > daemon-secret env > legacy-token env,
and env-over-config URL, token and token-file precedence, including missing-token rejection.
Timeout classification accepts only the exact known abort diagnostic; unrelated
errors mentioning abort remain intact.

The job golden passes its data directory explicitly and never changes TMPDIR or
NARRATIONLAYER_DATA_DIR. Only os.tmpdir() and its realpath assembly roots become
$TMPDIR/$ASSEMBLY_n, preserving temp-directory location in argv and concat. PATH and
COMPAT_ARGV remain process-global only around renderJob because the service/audio
API has no subprocess env argument. The whole NARRATIONLAYER_QWEN3_ env family
and auth fallback variables are similarly scoped to config resolution and renderJob; every changed key is restored in
finally before fixture deletion. Commit/profile discovery tests also retain their
narrow, restored env overrides. Run compat tests sequentially: concurrent tests
in the same process can still observe these unavoidable global overrides.
Runner child processes receive explicit env objects and do not change parent env.

The defaults cases use the same stub daemon and real tool wrappers. Three runner
goldens cover sentence-only and comma-only pause profiles (the omitted pause
defaults to 0.22 s and 0.55 s respectively), and breathing with both pauses set
but no `atempo`. Each freezes requests in order, pieces and pads, cache-key
preimage and receipt, output format, executed argv and concat entries, and the
summary's breathing note. The job defaults golden renders a gain-only profile
and freezes the executed EQ filter's default 4000 Hz corner. Every new test has
a 30-second budget; synchronous fixture encoding and output probes have their
own 10-second timeout.
