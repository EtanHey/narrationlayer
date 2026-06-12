# Architecture

NarrationLayer separates three responsibilities:

1. Job intake (`create-job`)
2. Segment rendering (`render`)
3. Result surfacing (`status`, `watch`, MCP tools)

Renderers are intentionally adapter-based:

- `fake` — deterministic local renderer used for onboarding and tests.
- `voicelayer-qwen3` — backend adapter stub in v0 that can be replaced by a real
  integration later.

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
- Keep CLI surface minimal.
- Keep contracts documented in schemas and docs so adapter swaps do not break callers.
