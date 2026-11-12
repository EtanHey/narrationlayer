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
points at it. It holds named re-exports only. A name is in it because an outside
consumer uses it, or because a public signature names it.

| Group | Names |
|---|---|
| Jobs | `createJobFromFile`, `createJobFromPayload`, `renderJob`, `getStatusSummary`, `getJobResult`, `listJobIds`, `getDoctorSummary`, and the job, manifest, words and renderer-config types their signatures use |
| Text | `normalizeForSpeech`, `normalizeLegacy`, `prepareSpeechChannels`, `deriveSpeechAliases`, `TermRule`, `SpeechChannels` |
| Planning | `Piece`, `utterancesV1`, `breathingV1`, `NarrationPacingConfig`, `PauseStrategy` |
| Word timing | `runWhisperCliWordTimings`, `normalizeWordTimingsForScript` and their option and result types |
| Local TTS | `runLocalTtsCli` (the runner's `main`: reads `process.argv`, takes an optional speech-preparation callback), `computeContentHashKey`, `writeTakeCacheReceipt`, `clearTakeCacheReceipt`, `CacheKeyParams`, `SpeechPreparation` |
| Teleprompter | `renderTeleprompterMarkup`, `teleprompterRuntimeScript`, `TeleprompterPayload`, `TeleprompterSegment` |

`tests/api/surface.snapshot.generated.json` records every public name, its kind
(value, type or both) and its signature as the TypeScript checker prints it,
with a sha256 over all of them. To change the surface on purpose:
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
| 2 backends, audio, timing | backends | `src/backends/qwen3-daemon.ts`: the one `/synthesize` HTTP client (request, bearer header, timeout, response check) |
| | audio | `src/audio.ts` (ffmpeg and ffprobe calls: trim, EQ, assemble with silence, probe duration, detect silences), `src/audio/ffmpeg-args.ts` (the runner's ffmpeg argv builders) |
| | timing | `src/word-timings.ts` (whisper-cli word timings), `src/word-timing-repair.ts` (align timings to the script), `src/timing/returned-timings.ts` (timings a daemon returns), `src/timing/script-words.ts` (script to words) |
| 3 pipelines | pipelines | `src/pipelines/job-render/index.ts` (the Qwen3 job renderer's stages), `…/job-render/synthesis.ts` (one synthesis call and the generated-chunk duration guard), `…/job-render/config.ts` (auth token, reference clip and text), `src/pipelines/job-render-provenance.ts` (commit and reference-clip hash), `src/pipelines/local-tts/take-cache.ts` (runner cache key and receipt), `src/renderers/fake.ts`, `src/renderers/external-command.ts`, `src/renderers/types.ts` (renderer interface), `src/renderers/voicelayer-qwen3.ts` (legacy re-export) |
| 4 service | service | `src/service.ts` (job lifecycle shared by CLI and MCP), `src/job-store.ts` (job folders, status, manifest, DONE/FAILED markers), `src/profiles.ts` (profile files and profile-to-config), `src/bakeoff.ts`, `src/qwen3-lora.ts` |
| 5 surfaces | surfaces | `src/cli.ts`, `src/mcp-server.ts`, `src/contract.ts` (MCP tool contract), `bin/local-tts-runner.ts`, `bin/narration-gate.ts`, `src/dashboard.ts`, `src/teleprompter.ts` |
| | dev | `scripts/dev/boundaries.ts`, `scripts/dev/snapshot-exports.ts`, `scripts/dev/snapshot-surface.ts` |
| api | api | `src/api/index.ts` |

Named exemptions (a ledger `exempt` instead of an owner slice): `bin/narration-gate.ts`,
`src/bakeoff.ts`, `src/qwen3-lora.ts`, `src/dashboard.ts`, `src/teleprompter.ts`,
`scripts/`, and `src/job-store.ts` (not edited: the formal model pins its hash).

## Import rules and the tests that enforce them

| Rule | Enforced by |
|---|---|
| A file imports only from its own layer or lower layers. Every form counts: `import`, `import type`, `export … from`, `import("…")` types, dynamic `import()`, `require()`. | `tests/architecture/boundaries.test.ts` (`scripts/dev/boundaries.ts`) |
| At layer 2, backends, audio and timing never import each other. | same |
| Nothing under `src/`, `bin/` or `scripts/` imports `src/api/`. Tests may. | same (`via-api`) |
| Every tracked `.ts` file under `src/`, `bin/` and `scripts/` has one ledger row; every relative import resolves to a tracked file. | same |
| `tests/architecture/baseline.json` lists tolerated violations; it is empty and may only shrink. | same |
| `src/cli.ts`, `src/mcp-server.ts`, `bin/local-tts-runner.ts`, `bin/narration-gate.ts` keep their `import.meta.main` block; the runner keeps `path.resolve(import.meta.dir, "..")`. | same |
| Exactly one module builds a `/synthesize` request. | `tests/architecture/daemon-client.test.ts` |
| `fake` and `external-command` have no import edge to the Qwen3 renderer or the pipelines. | `tests/architecture/renderer-split.test.ts` |
| Functions moved out of the runner are declared once, in their library module. | `tests/architecture/runner-split.test.ts` |
| Both planning policies return the one `Piece` type. | `tests/architecture/plan-type.test.ts` (under `tsc`) |
| Every legacy module path, exported name and its meaning (value or type) still resolves. | `tests/compat/legacy-paths.test.ts` |
| The public surface matches its snapshot; every repo type a public signature names is public; `src/api/index.ts` holds named re-exports only. | `tests/api/surface.test.ts` |
| `exports` is exactly the front door, `package.json` and the legacy modules; by package name the front door and legacy subpaths resolve and no other module does. | `tests/api/exports.test.ts` |
| MCP tool names and input schemas, CLI verbs and the `bin` map are frozen; the MCP server answers `initialize` and `tools/list` over stdio; `bun build src/cli.ts` succeeds. | `tests/compat/surfaces.test.ts`, `tests/mcp-contract.test.ts` |
| Daemon requests, files written, ffmpeg argv, exit codes and errors of both render paths match goldens. | `tests/compat/job-golden.test.ts`, `tests/compat/runner-executable.test.ts`, `tests/compat/plan-pieces.test.ts`, `tests/compat/daemon-observables.test.ts`; sensitivity: `bun tests/compat/mutations.ts` |
| The job store's source matches the formal model. | `formal/narration-contract/check.sh` |

Not enforced by a test at this commit: inside the repo, import a name from the
module that declares it, not through a legacy path.

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
4. synthesis per utterance: `synthesizeText` (`src/pipelines/job-render/synthesis.ts`) over `synthesizeQwen3` (`src/backends/qwen3-daemon.ts`); a chunk that fails the duration guard is retried up to `max_chunk_retries`
5. per chunk: silence trim (or `audio_postprocessor`), high-shelf EQ when configured (`src/audio.ts`)
6. assembly with silence pads when there is more than one utterance or a pause (or `audio_assembler`)
7. duration: `probeAudioDurationSeconds` (or `audio_duration_probe`)
8. word timings: from the daemon response (`src/timing/returned-timings.ts`), else `word_timing_provider`, else whisper-cli when `timing_backend` is `whisper-cli` (`src/word-timings.ts`); then repair against the script (`src/word-timing-repair.ts`); `words.json` written
9. provenance: profile, model, commit and reference-clip hash (`src/pipelines/job-render-provenance.ts`)

`renderJob` then writes the manifest and status and the DONE or FAILED marker
(`src/job-store.ts`).

Runner path: `bin/local-tts-runner.ts` (`main`, public as `runLocalTtsCli`)
renders one text to one WAV:

1. argv; clear the take-cache receipt (`src/pipelines/local-tts/take-cache.ts`)
2. reference: a profile name (`src/profiles.ts`: `profiles.example.yaml` and `profiles.local.yaml` in the runner's parent directory, plus `NARRATIONLAYER_PROFILES_FILE`) or a direct clip path; read the auth token file
3. spoken text: the injected speech preparation, default `prepareSpeechChannels` (`src/text-normalize.ts`)
4. cache: `computeContentHashKey`; on a HIT copy the frozen WAV, write `.spoken.txt` and the receipt, stop
5. synthesis of the whole text: `synthesizeQwen3` (`src/backends/qwen3-daemon.ts`)
6. ffmpeg to mono s16 WAV with optional high-shelf EQ (argv from `src/audio/ffmpeg-args.ts`)
7. breathing, when the profile sets a sentence or comma pause: `breathingV1` (`src/plan/`); with two or more pieces, each piece is synthesized again, converted, tempo-adjusted when `atempo` is set, and concatenated with PCM silence pads
8. tempo (`atempo`) when breathing did not assemble
9. loudness normalization when a target is set
10. `.spoken.txt`, the receipt, and the frozen take stored in the cache

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

- A new TTS engine client: a file in `src/backends/` (layer 2); its config shape in `src/core/render-types.ts`; the stages that call it in `src/pipelines/` (layer 3); a renderer name in `RendererName` (`src/schema.ts`) and a branch in `renderJob` (`src/service.ts`).
- A new audio step: argv builders in `src/audio/ffmpeg-args.ts`, ffmpeg calls in `src/audio.ts`.
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
