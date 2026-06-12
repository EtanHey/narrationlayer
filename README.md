# NarrationLayer

NarrationLayer is a public-safe, backend-agnostic narration orchestration layer.
It turns structured explanatory scripts into durable narrated assets with renderer
pluggability (`fake` for local offline smoke-test workflows and optional
`voicelayer-qwen3` adapter in v0 stub form).

It is intentionally not Theo-specific: renderer backends are adapters only, and
repo identity stays neutral.

## Storage

- Default data directory: `~/.narrationlayer`
- Override with `NARRATIONLAYER_DATA_DIR`
- Each job is stored under `<data-dir>/jobs/<job-id>/` with:
  - `job.json`
  - `status.json`
  - `manifest.json`
  - `DONE` or `FAILED`

## CLI

```bash
bun run narrationlayer doctor
bun run narrationlayer create-job <job.json>
bun run narrationlayer render <job-id>
bun run narrationlayer status <job-id>
bun run narrationlayer watch <job-id>
```

## MCP

Starts a minimal stdio MCP server in `src/mcp-server.ts` exposing:

- `create_narration_job`
- `get_narration_status`
- `get_narration_result`
- `list_narration_jobs`

```bash
bun run mcp-server
```

## Manifest & Teleprompter Contracts

- `schemas/narration-job.schema.json`
- `schemas/render-manifest.schema.json`
- `schemas/words.schema.json`

The manifest contract includes segment timing references (`audio_path`, `words_path`)
so downstream systems can support teleprompter word-highlighting workflows
without shipping giant transcripts.

## Development

```bash
bun install
bun test
bun run narrationlayer doctor
```

## Repository Layout

- `src/cli.ts` — CLI command implementation
- `src/mcp-server.ts` — MCP stdio server
- `src/job-store.ts` — filesystem storage helpers
- `src/renderers/fake.ts` — deterministic fake renderer for v0
- `src/renderers/voicelayer-qwen3.ts` — adapter stub/config holder
- `src/schema.ts` — schema and validation helpers
