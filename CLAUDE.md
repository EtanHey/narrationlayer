## NarrationLayer Project Instructions

### Scope

Keep all code public-safe and backend-neutral. Do not add Theo-specific behavior,
assets, secrets, or private voice materials.

### Storage and privacy

- Keep private artifacts out of git.
- Use `.gitignore` coverage for local/private files.
- Never commit `.env`, `.secret`, `daemon.secret`, `profiles.local.yaml`,
  reference wav/mp3/m4a/flac/opus, transcripts tied to private reference audio,
  or real cloned-voice source material.

### Local safety

Do not infer missing tokens or secrets. Keep renderer adapters configurable and
explicit.

### Verification

Before assuming success, run:

- `bun test`
- `bun run narrationlayer doctor`
- `bun run narrationlayer create-job examples/sample-job.json`
- `bun run narrationlayer render <job-id>`
- `bun run narrationlayer status <job-id>`

### Module rules

- Each file's layer is its row in `tests/architecture/ledger.json` (0 core; 1 text, plan; 2 backends, audio, timing;
  3 pipelines; 4 service; 5 surfaces; `api`). A file imports only from its own layer or lower; layer-2 areas never
  import each other; every new file gets a ledger row.
- A ledger `"shim": true` file holds only re-exports and only `tests/compat/` imports it (`shims.test.ts`). Review,
  not a test, checks that a moved name is imported from its declaring module, also where an older module still
  re-exports it (`bin/local-tts-runner.ts`; core types via `src/audio.ts`, `src/word-timings.ts`, `src/schema.ts`).
- Public means `src/api/index.ts`, the package's `"."` export; nothing in `src/`, `bin/` or `scripts/` imports it.
  Changing it needs `bun scripts/dev/snapshot-surface.ts --update` and the reason in the PR.
- The root checkout is run by an outside consumer: entry files stay at their paths and master must always work.
- An audible change to the runner's cutting, pauses or ffmpeg chain raises `LOCAL_TTS_RENDER_VERSION`;
  `tests/compat/take-cache-version.test.ts` says when, and any edit to its table's entries beyond what that test prints is a review stop.
- Module map, import rules and where new work goes: `docs/architecture.md`.
- Gates: `bun install --frozen-lockfile`, `bun test`, `bunx tsc --noEmit`, `bun tests/compat/mutations.ts`,
  `formal/narration-contract/check.sh`.
