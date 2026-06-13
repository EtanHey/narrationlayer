# Architecture

NarrationLayer separates three responsibilities:

1. Job intake (`create-job`)
2. Segment rendering (`render`)
3. Result surfacing (`status`, `watch`, MCP tools)

Renderers are intentionally adapter-based:

- `fake` — deterministic local renderer used for onboarding and tests.
- `voicelayer-qwen3` — optional local VoiceLayer/Qwen3 daemon adapter. It is
  configured by env vars or ignored local profiles and is mockable in tests.
- `external-command` — public-safe bridge to local runners. Private profiles can
  point this at F5-TTS MLX, IndexTTS2, VoxCPM2, or another local executable
  without adding model-specific private setup to this repo.

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

- Keep rendering logic testable in `src/renderers/*`.
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
