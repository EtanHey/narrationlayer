# Architecture

NarrationLayer separates three responsibilities:

1. Job intake (`create-job`)
2. Segment rendering (`render`)
3. Result surfacing (`status`, `watch`, MCP tools)

Renderers are adapter-based:

- `fake` — deterministic local renderer used for onboarding and tests.
- `voicelayer-qwen3` — optional local VoiceLayer/Qwen3 daemon adapter. It is
  configured by env vars or ignored local profiles and is mockable in tests.
- `external-command` — public-safe bridge to local runners. Private profiles can
  point this at F5-TTS MLX, IndexTTS2, VoxCPM2, or another local executable
  without adding model-specific private setup to this repo.

## Public surface

`src/api/index.ts` is the package's front door: `package.json` `exports["."]`
points at it. It holds named re-exports only: 21 runtime values and 35 types. A
name is in it because it was meant for outside callers, or because a public
declaration names it. No per-name inventory of outside callers exists, so which
names an outside consumer really uses is not recorded here.

| Group | Names |
|---|---|
| Jobs | `createJobFromFile`, `createJobFromPayload`, `renderJob`, `getStatusSummary`, `getJobResult`, `listJobIds`, `getDoctorSummary`, and the job, manifest, words and renderer-config types their signatures use |
| Text | `normalizeForSpeech`, `normalizeLegacy`, `prepareSpeechChannels`, `deriveSpeechAliases`, `TermRule`, `SpeechChannels` |
| Planning | `Piece`, `utterancesV1`, `breathingV1`, `NarrationPacingConfig`, `PauseStrategy` |
| Word timing | `runWhisperCliWordTimings`, `normalizeWordTimingsForScript` and their option and result types |
| Local TTS | `runLocalTtsCli` (the runner's `main`: reads `process.argv`, takes an optional speech-preparation callback, and ends the process: see the runner path below), `computeContentHashKey`, `writeTakeCacheReceipt`, `clearTakeCacheReceipt`, `CacheKeyParams`, `SpeechPreparation` |
| Teleprompter | `renderTeleprompterMarkup`, `teleprompterRuntimeScript`, `TeleprompterPayload`, `TeleprompterSegment` |

`tests/api/surface.snapshot.generated.json` holds a sha256 over the compiler's own
declaration output (`--declaration --emitDeclarationOnly`, in memory) for
`src/api/index.ts` and every repo `.d.ts` its declarations reach, in sorted order
with repo-relative paths. That hash decides. Next to it are each file's hash and
each public name's kind and emitted declaration, which name what changed when the
test fails. A public declaration may name only public repo types, TypeScript's
library types, and Bun and `node:` types. To change the surface on purpose:
`bun scripts/dev/snapshot-surface.ts --update`, and give the reason in the PR.

`package.json` `exports` also lists every legacy module (below) as a subpath
under its file path, for example `narrationlayer/src/schema.ts`, plus
`narrationlayer/package.json`. No other module resolves by package name.

## Layers

A file's layer is its row in `tests/architecture/ledger.json`, not its folder.

| Layer | Area | Modules |
|---|---|---|
| 0 core | core | `src/core/render-types.ts` (pacing, renderer-config, audio-chunk and word-timing-result shapes), `src/schema.ts` (job, manifest, words shapes; `parseNarrationJob`, `parsePathId`), `src/path-safety.ts` (`resolveWithinRoot`), `src/profile-renderer-types.ts` (legacy re-export) |
| 1 text, plan | text | `src/text-normalize.ts`: display text to spoken text (`TERM_MAP`, pronunciation rules, speech aliases) |
| | plan | `src/plan/index.ts` (`Piece`, `utterancesV1`, `breathingV1`, the two legacy-shape adapters), `src/plan/utterances.ts` (job cutter), `src/plan/breathing.ts` (runner cutter), `src/narration-plan.ts` (legacy re-export) |
| 2 backends, audio, timing | backends | `src/backends/qwen3-daemon.ts`: the Qwen3 daemon transport only: POST of a caller-given URL and body, bearer header, timeout, HTTP status check, JSON parse and `audio_b64` check, typed `Qwen3DaemonError`. It never builds the `/synthesize` URL or the request body; `src/pipelines/job-render/synthesis.ts` and `src/pipelines/local-tts/synthesis.ts` do (see the render paths below) |
| | audio | `src/audio.ts` (ffmpeg and ffprobe calls: trim, EQ, assemble with silence, probe duration, detect silences), `src/audio/ffmpeg-args.ts` (the runner's ffmpeg argv builders), `src/audio/ffmpeg-run.ts` (the runner's ffmpeg execution and volume measurement) |
| | timing | `src/word-timings.ts` (whisper-cli word timings), `src/word-timing-repair.ts` (align timings to the script), `src/timing/returned-timings.ts` (timings a daemon returns), `src/timing/script-words.ts` (script to words) |
| 3 pipelines | pipelines | `src/pipelines/job-render/index.ts` (the Qwen3 job renderer's stages), `…/job-render/synthesis.ts` (one synthesis call and the generated-chunk duration guard), `…/job-render/config.ts` (auth token, reference clip and text), `src/pipelines/job-render-provenance.ts` (commit and reference-clip hash), `src/pipelines/local-tts/index.ts` (resolved-config runner orchestration), `…/local-tts/synthesis.ts` (daemon call and runner error translation), `…/local-tts/failure.ts` (former exit failures), `…/local-tts/breathing.ts` (per-piece synthesis and assembly), `…/local-tts/keep-pieces.ts` (`--keep-pieces` copies and `pieces.json`), `…/local-tts/loudness.ts` (normalization stage), `…/local-tts/take-cache.ts` (runner cache key and receipt), `src/renderers/fake.ts`, `src/renderers/external-command.ts`, `src/renderers/types.ts` (renderer interface), `src/renderers/voicelayer-qwen3.ts` (legacy re-export) |
| 4 service | service | `src/service.ts` (job lifecycle shared by CLI and MCP), `src/job-store.ts` (job folders, status, manifest, DONE/FAILED markers), `src/profiles.ts` (profile files and profile-to-config), `src/bakeoff.ts`, `src/qwen3-lora.ts` |
| 5 surfaces | surfaces | `src/cli.ts`, `src/mcp-server.ts`, `src/contract.ts` (MCP tool contract), `bin/local-tts-runner.ts` (argv, profile and auth resolution, summaries and process exits, see the runner path), `bin/narration-gate.ts`, `src/dashboard.ts`, `src/teleprompter.ts` |
| | dev | `scripts/dev/boundaries.ts`, `scripts/dev/snapshot-exports.ts`, `scripts/dev/snapshot-surface.ts` |
| api | api | `src/api/index.ts` |

Named exemptions (a ledger `exempt` instead of an owner slice): `bin/narration-gate.ts`,
`src/bakeoff.ts`, `src/qwen3-lora.ts`, `src/dashboard.ts`, `src/teleprompter.ts`,
`scripts/`, and `src/job-store.ts` (not edited: the formal model pins its hash).

## Import rules and the tests that enforce them

| Rule | Enforced by |
|---|---|
| A file imports only from its own layer or lower layers. Every form counts: `import`, `import type`, `export … from`, `import("…")` types, dynamic `import()`, `require()`; and every spelling of a repo file: relative, absolute, `file:` URL, or the package's own name resolved through `exports`. | `tests/architecture/boundaries.test.ts` (`scripts/dev/boundaries.ts`) |
| At layer 2, backends, audio and timing never import each other. | same |
| Nothing under `src/`, `bin/` or `scripts/` imports `src/api/`, by path or as `narrationlayer`. Tests may. | same (`via-api`) |
| Every tracked `.ts` file under `src/`, `bin/` and `scripts/` has one ledger row; every relative import resolves to a tracked file. | same |
| `tests/architecture/baseline.json` lists tolerated violations; it is empty and may only shrink. | same |
| `src/cli.ts`, `src/mcp-server.ts`, `bin/local-tts-runner.ts`, `bin/narration-gate.ts` keep their `import.meta.main` block; the runner keeps `path.resolve(import.meta.dir, "..")`. | same |
| Under `src/` and `bin/`, `src/backends/qwen3-daemon.ts` is the one module with a call whose type-checked return type is `Promise<Response>` (an HTTP transport call, however the callee is spelled). It does not check where the URL or body is built. | `tests/architecture/daemon-client.test.ts` |
| `src/renderers/fake.ts` and `src/renderers/external-command.ts` have no relative import of `src/renderers/voicelayer-qwen3.ts` or of any file under `src/pipelines/` (the Qwen3 job-render pipeline, its provenance, the take cache). Both files are themselves in the pipelines area; the test does not look at `src/backends/`. | `tests/architecture/renderer-split.test.ts` |
| Functions moved out of the runner are declared once, in their library module. | `tests/architecture/runner-split.test.ts` |
| A file flagged `"shim": true` in the ledger holds only re-export statements; only files under `tests/compat/` import it (every import form and spelling, as for the layer rule, from any tracked source file); a tracked file under `src/` or `bin/` that holds only re-export statements and has no flag fails, except `src/api/index.ts`, which may not be a shim (the same file under `scripts/` or `tests/` is not checked unless flagged). The flagged shims: `src/narration-plan.ts`, `src/profile-renderer-types.ts`, `src/renderers/voicelayer-qwen3.ts`. | `tests/architecture/shims.test.ts` |
| Both planning policies return the one `Piece` type. | `tests/architecture/plan-type.test.ts` (under `tsc`) |
| Every legacy module path, exported name and its meaning (value or type) still resolves. | `tests/compat/legacy-paths.test.ts` |
| The public surface matches its snapshot (declaration-output hash); every repo type a public declaration names is public; no public declaration names a third-party package type; `src/api/index.ts` holds named re-exports only. | `tests/api/surface.test.ts` |
| `exports` is exactly the front door, `package.json` and the legacy modules; by package name the front door and legacy subpaths resolve and no other module does. | `tests/api/exports.test.ts` |
| MCP tool names and input schemas, CLI verbs and the `bin` map are frozen; the MCP server answers `initialize` and `tools/list` over stdio; `bun build src/cli.ts` succeeds. | `tests/compat/surfaces.test.ts`, `tests/mcp-contract.test.ts` |
| Daemon requests, files written, ffmpeg argv, exit codes and errors of both render paths match goldens. | `tests/compat/job-golden.test.ts`, `tests/compat/runner-executable.test.ts`, `tests/compat/plan-pieces.test.ts`, `tests/compat/daemon-observables.test.ts`; sensitivity: `bun tests/compat/mutations.ts` |
| The job store's source matches the formal model. | `formal/narration-contract/check.sh` |

Not enforced by a test, checked in review: import a name from the module that
declares it, also where another module that has code of its own (so is not a
shim) still re-exports it. The cases at this commit: `bin/local-tts-runner.ts`
re-exports the ffmpeg argv builders (`src/audio/ffmpeg-args.ts`),
`splitForBreathing` (`src/plan/breathing.ts`) and the take-cache names
(`src/pipelines/local-tts/take-cache.ts`); `src/audio.ts` re-exports
`AudioAssemblyChunk`, `src/word-timings.ts` `WordTimingResult`, `src/schema.ts`
`VoiceLayerQwen3Config` and `ExternalCommandConfig`,
`src/renderers/external-command.ts` `ExternalCommandConfig`, and
`src/plan/utterances.ts` `NarrationPacingConfig` and `PauseStrategy`, all
declared in `src/core/render-types.ts`.

The hosted `test` workflow (`.github/workflows/test.yml`) runs `bun test`,
`bunx tsc --noEmit` and the formal model check on every PR.

## The two render paths

Job path: `narrationlayer render <job-id>` or the MCP render tool calls
`renderJob` in `src/service.ts`, which loads the job (`src/job-store.ts`),
resolves the renderer config from the voice profile (`src/profiles.ts`) unless
one is passed, and renders each segment with the job's renderer. For
`voicelayer-qwen3`, `renderSegment` in `src/pipelines/job-render/index.ts` runs:

1. spoken text: `normalizeForSpeech` (`src/text-normalize.ts`)
2. config: auth token, reference clip and text (`src/pipelines/job-render/config.ts`)
3. plan: `utterancesV1`, adapted to the legacy utterance shape (`src/plan/`)
4. per utterance, inside a retry loop of up to `max_chunk_retries` extra attempts: synthesis with `synthesizeText` (`src/pipelines/job-render/synthesis.ts`, which builds the `/synthesize` URL and the request body, with the LoRA fields) over `synthesizeQwen3` (`src/backends/qwen3-daemon.ts`); silence trim (or `audio_postprocessor`) when `trim_silence` is true; high-shelf EQ when configured (`src/audio.ts`); then the duration guard `assertGeneratedChunkDuration`, whose runaway-chunk error starts the next attempt
5. assembly with silence pads (or `audio_assembler`) when there is more than one utterance or a pause; the spoken text is written to `<audio>.spoken.txt`
6. duration: the segment's authored `duration_seconds` when set, else `probeAudioDurationSeconds` (or `audio_duration_probe`), else the sum of the daemon-reported durations and pauses, else 0
7. word timings: from the daemon response when the segment was not assembled (`src/timing/returned-timings.ts`); when that gives none, either `word_timing_provider` if configured or, otherwise, whisper-cli when `timing_backend` is `whisper-cli` (`src/word-timings.ts`), never both; repair against the script (`src/word-timing-repair.ts`) only when there are timings and the script differs from the spoken text or `repair_word_timings` (default: true when `timing_backend` is `whisper-cli`) asks for it; `words.json` written
8. provenance: profile, model, commit and reference-clip hash (`src/pipelines/job-render-provenance.ts`)

`renderJob` then writes the manifest and status and the DONE or FAILED marker
(`src/job-store.ts`).

Runner path: `bin/local-tts-runner.ts` (`main`, public as `runLocalTtsCli`)
resolves argv, profiles and auth, then calls `renderLocalTts`
(`src/pipelines/local-tts/index.ts`) to render one text to one WAV. The pipeline
returns a typed cache-hit or rendered result; the entry prints the summary and exits.

`main` ends the process with `process.exit`: exit 0 on success, on a cache hit
and on `--help`; exit 1 on every error it reports through its `fail()` helper
(arguments, profile and reference, token file, speech preparation, daemon HTTP
status and missing audio, an empty cached or output WAV). Other errors (a daemon
timeout, network or malformed-JSON error, an ffmpeg failure) reject its promise,
and only the bin's own `import.meta.main` block turns them into exit 1. So a host
must not call it in its own process; it runs it in a child process.

1. argv; clear the take-cache receipt (`src/pipelines/local-tts/take-cache.ts`)
2. reference: a profile name (`src/profiles.ts`: `profiles.example.yaml` and `profiles.local.yaml` in the runner's parent directory, plus `NARRATIONLAYER_PROFILES_FILE`) or a direct clip path; read the auth token file
3. pipeline spoken text: the injected speech preparation, default `prepareSpeechChannels` (`src/text-normalize.ts`)
4. cache: `computeContentHashKey`; when caching is on (the default; `--no-cache` turns it off), `--refresh-cache` is not given, and the key's WAV exists, copy it, write `.spoken.txt` and the receipt, stop (with `--keep-pieces` the receipt says no pieces were rendered)
5. synthesis of the whole text: `synthesize` (`src/pipelines/local-tts/synthesis.ts`) builds the `/synthesize` URL and the request body and calls `synthesizeQwen3` (`src/backends/qwen3-daemon.ts`)
6. ffmpeg to mono s16 WAV with optional high-shelf EQ (`src/audio/ffmpeg-run.ts`, argv from `src/audio/ffmpeg-args.ts`)
7. breathing (`src/pipelines/local-tts/breathing.ts`), when the profile sets a sentence or comma pause: `breathingV1` (`src/plan/`); with two or more pieces, each piece is synthesized again, converted, tempo-adjusted when `atempo` is set, and concatenated with PCM silence pads
8. tempo (`atempo`) when breathing did not assemble; with `--keep-pieces <dir>`, each piece as it went into the join (or the whole take, as one piece, when it was not cut) is copied to `<dir>` with `pieces.json` (`src/pipelines/local-tts/keep-pieces.ts`)
9. loudness normalization (`src/pipelines/local-tts/loudness.ts`) when a target is set
10. `.spoken.txt` written; when caching is on, the take is copied into the cache (temp file and rename), and a failed copy is logged, not an error, except under `--refresh-cache`, where it fails the run and the old entry stays; then the receipt is written (`cacheRefreshed` under `--refresh-cache`, `keptPieces` under `--keep-pieces`). Neither switch is in the cache key or changes the audio

The cache key does not cover the code that turns its inputs into audio: the
breathing cuts and default pauses (`src/plan/`, `src/pipelines/local-tts/breathing.ts`),
the synthesis requests (`src/pipelines/local-tts/synthesis.ts`), the ffmpeg chain
(`src/audio/ffmpeg-args.ts`, `src/audio/ffmpeg-run.ts`, `src/pipelines/local-tts/loudness.ts`)
and the order of the stages (`src/pipelines/local-tts/index.ts`). So
`LOCAL_TTS_RENDER_VERSION` in `src/pipelines/local-tts/take-cache.ts` stands in
for it. An audible change to that code raises the version, which makes every
consumer's cached take miss once; version 1 is left out of the hashed text, so
keys from before the version existed still hit.
`tests/compat/take-cache-version.test.ts` fingerprints each golden case (one
runner run, keyed by its cache-key inputs, or one breathing row of the
plan-pieces golden) over its daemon request bodies, breathing pieces and ffmpeg
calls, and compares with the current row of
`tests/compat/fixtures/take-cache-render-versions.json`. It is a tripwire, not a
judge of audibility. When a case whose key is unchanged moves, someone decides:
if the audio for that key changed, raise the version (the test prints the steps:
set the constant, regenerate every runner golden that records a cache key or key
preimage, which it lists with the test files that write them, and append a row);
if it did not (independent steps reordered, a temporary or preparatory step, a
renamed role), re-record the printed entries and add the reason, and how it was
shown, to the row's `rerecorded` list. A raise's own regeneration (every runner
golden that records a cache key or key preimage) comes after the behaviour
regeneration described in `tests/compat/README.md`, so each file it rewrites may
differ from the one before only in key material (the version in each key preimage
and the cache keys); a diff beyond that is a review stop. A case whose key inputs changed (a normalization change, say) asks for
its entries to be replaced, not for a raise: its key changed by itself. A new
golden case alone is added to the current row without a raise; but if it was added
to show a change to the runner's cutting, pauses or ffmpeg chain, that change is
audible for texts already cached and raises the version, even though no recorded
case moved (the test prints the raise steps there too). The guard sees only the
corpus texts and the recorded request bodies, pieces and ffmpeg arguments: a rule
that no corpus text exercises (an abbreviation rule, say), or a stage whose
arguments stay the same while its result changes, alters the audio without tripping
it, and still requires a raise. The table can always be
edited to agree with the goldens, so review holds the rest:
An existing entry of a recorded row changes in only three ways, each named by
this test: a version raise appends a new row; a change to a case's cache-key
inputs (its spoken text, reference, profile or parameters) replaces the entries
the test prints; and when the audio for an unchanged key did not change, an
attested re-record rewrites the entries the test prints and adds a line with its
reason to the row's rerecorded list. Anything else, and any change to the
projection or the run split in tests/compat/take-cache-version.test.ts, is a
review stop.

## Legacy paths

`tests/compat/legacy-paths.manifest.generated.json` freezes 24 modules (every
`src/**/*.ts` and `bin/*.ts` module at commit `f7faa867`) with each export and its
meaning. They stay because code outside this repo reaches them by file path:
AfterCode spawns `bin/local-tts-runner.ts`, untracked scripts in a checkout import
`src/service.ts`, `src/schema.ts`, `src/teleprompter.ts` and `src/word-timings.ts`,
and copies of several modules are vendored elsewhere. Where code moved, the old
file re-exports from the new one: `src/narration-plan.ts`,
`src/profile-renderer-types.ts`, `src/renderers/voicelayer-qwen3.ts`, part of
`bin/local-tts-runner.ts`, and the types `src/audio.ts` and `src/word-timings.ts`
take from `src/core/`. New code imports the declaring module; outside code moves to
the front door.

## Where new work goes

Every new file gets a ledger row (layer, area, owner).

- A new TTS engine client touches, today:
  - a transport file in `src/backends/` (layer 2) and its config shape in `src/core/render-types.ts`;
  - the stages that call it in `src/pipelines/` (layer 3): a new pipeline, because `src/pipelines/job-render/` is bound to Qwen3 (its config type, its request body, its error texts);
  - the renderer name in `RendererName` and the parse branch in `normalizeRenderer` (`src/schema.ts`), which turns any unknown name into `fake`;
  - the `isRenderer` lists in `src/profiles.ts` and `src/bakeoff.ts`, and a profile-to-config function in `src/profiles.ts` (like `qwenConfigFromProfile`);
  - in `src/service.ts`, a field in `RendererRuntimeConfig`, its fill in `getRendererConfigFromEnv` and `getRendererConfigForVoiceProfile`, and a branch in `renderJob`;
  - a type re-export in `src/api/index.ts` for the new config type and any other repo type it newly makes public: `RendererRuntimeConfig` is public, and `tests/api/surface.test.ts` fails, and `bun scripts/dev/snapshot-surface.ts --update` refuses to write, while a public declaration names an unexported repo type;
  - the runner path, if the runner is to use it: `src/pipelines/local-tts/synthesis.ts` calls `synthesizeQwen3` with its own body;
  - `tests/architecture/daemon-client.test.ts`, which fails by design for a second HTTP transport module and must be changed on purpose;
  - then the public surface snapshot (`bun scripts/dev/snapshot-surface.ts --update`, with the reason in the PR), because `RendererName` and `RendererRuntimeConfig` are public.
- A new audio step: argv builders in `src/audio/ffmpeg-args.ts`, ffmpeg calls in `src/audio.ts` or `src/audio/ffmpeg-run.ts`.
- A new timing step: `src/timing/`.
- A new planning policy: `src/plan/`, returning `Piece[]`, exported from `src/plan/index.ts`.
- A new spoken-form rule: `src/text-normalize.ts`.
- A new MCP tool: `src/contract.ts`, `src/mcp-server.ts`, `docs/mcp-tools.json`, `docs/mcp-contract.md`.
- A new CLI verb: `src/cli.ts`.
- A name outside consumers need: a re-export in `src/api/index.ts` and a regenerated surface snapshot.

## Directory layout

```
~/.narrationlayer/
└── jobs/
    └── <job-id>/
        ├── job.json
        ├── status.json
        ├── manifest.json
        ├── DONE | FAILED
        └── artifacts/
            └── segments/<segment-id>/
```

## Design choices

- Keep storage behavior stable and explicit in `src/job-store.ts`.
- Keep CLI and MCP behavior on the same `src/service.ts` path.
- Keep MCP tool names, descriptions, and input schemas in `src/contract.ts`.
- Test contract drift against `docs/mcp-tools.json` and `docs/mcp-contract.md`.
- Keep private profiles in ignored `profiles.local.yaml` or
  `NARRATIONLAYER_PROFILES_FILE`.
- Keep bakeoffs as normal jobs: one shared script set expands to one job per
  candidate, so dashboards, manifests, and timing repair stay reusable.
- Keep the generated dashboard as a local demo artifact, not a hosted dashboard
  product in this repo.
