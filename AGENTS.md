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
