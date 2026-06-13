# Goal: NarrationLayer v1 Agent Narration Service

## Context

- Repo: `/Users/etanheyman/Gits/narrationlayer`
- Public GitHub repo: `https://github.com/EtanHey/narrationlayer`
- Launchers: `narrationlayerCodex`, `narrationlayerClaude`, `narrationlayerCursor`, `narrationlayerGemini`, `narrationlayerKiro`
- repoGolem MCPs are wired for this repo: `brainlayer`, `voicelayer`, `exa`, `cmux`, `context7`
- This repo must stay neutral and public-safe. It is not Theo-specific.
- Private voice clips, voice IDs, transcripts, `profiles.local.yaml`, tokens, and generated audio stay out of git.

## Objective

Turn the current v0 scaffold into a stable minimal v1 for creating explanatory narration assets for dashboards and agent workflows.

Today the main use case is dashboard/build-time generation: an agent or script asks NarrationLayer to turn structured scripts into audio, manifest files, and word timing files, then a dashboard consumes those assets. Future live dashboard or MCP usage should remain possible, but do not overbuild live orchestration now.

Keep it small, boring, testable, sophisticated, stable, concise, and modular for agents.

## Architecture Constraint: No Contract Drift

Do not let the CLI, MCP tool list, tool descriptions, schemas, and docs drift from each other.

The MCP surface must describe exactly what the implementation does. Prefer one shared contract source for CLI/MCP schemas and add tests that fail if tool names, descriptions, input schemas, or documented behavior drift from the actual handlers.

This is a core requirement, not a polish task.

## Narration UX Contract

Generated explanatory narration must be understandable to a user who is listening while mobile, multitasking, or seeing only part of the dashboard.

For decision or question segments, do not jump directly into reasoning. Use this order:

1. State the actual question in plain language.
2. Name the available options.
3. Explain what each option means.
4. Then explain the reasoning, tradeoffs, and recommendation.
5. End with the concrete decision the user is being asked to make.

The manifest/schema should have room for this structure so dashboards can show the same structure visually: question, options, reasoning, recommendation, and user-decision-needed fields.

Tool and CLI descriptions should also be user-legible. A future agent reading a tool description should understand what the tool can actually generate and how to request understandable explanatory audio. Do not hide user preferences only in prose docs if they affect output shape; encode them in schemas, examples, or profile/config where practical.

## Runtime Decision

The repo currently has a TypeScript/Bun scaffold. Do not rewrite it just because another runtime sounds nicer.

First write a short ADR in `docs/adr/runtime.md` that answers one of these:

- Keep TypeScript/Bun.
- Move to Python.
- Move to Rust.
- Split components across runtimes.

Default to keeping TypeScript/Bun for v1 unless there is a concrete reason not to.

If you recommend Python or Rust, justify:

- migration cost
- local VoiceLayer integration
- MCP SDK maturity
- test ergonomics
- packaging
- future isolated Happy Campr user setup

Do not start a rewrite without this ADR and a narrow migration plan.

## Gemini Deep Research

Do not block v1 on broad Gemini Deep Research.

If you believe external research is needed, write the exact research question and explain why local repo/VoiceLayer evidence is insufficient. The likely v1 decision should be made from this repo, VoiceLayer local contracts, MCP implementation patterns, and tests.

## Read First

1. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/mcp-contract.md`
5. `docs/teleprompter-contract.md`
6. `schemas/*.json`
7. `src/cli.ts`, `src/mcp-server.ts`, `src/job-store.ts`, `src/renderers/*`
8. `/Users/etanheyman/Gits/voicelayer`, only for the local Qwen3/VoiceLayer daemon contract. Do not copy any private voice assets or private settings.

## Required Work

1. Tighten the job lifecycle: `queued -> rendering -> done/failed`, atomic writes where useful, stable status JSON, stable manifest JSON, and clear failed segment errors.
2. Make the renderer interface explicit. Keep the fake renderer deterministic. Add or complete a VoiceLayer/Qwen3 adapter that can call the local VoiceLayer service through config/env/profile, but make it mockable so tests do not need real TTS.
3. Add a word-timing contract that dashboards can consume: per-segment `words_path` JSON with `word`, `start`, `end`, and optional `confidence`. Fake renderer should generate deterministic word timings. Real adapter should preserve returned timings when available and explicitly mark timing as unavailable when the backend cannot provide it yet.
4. Improve the MCP server so agents can create jobs, start rendering, poll status, fetch manifests/results, and list jobs with predictable JSON schemas. Keep tool descriptions precise and short. Add drift tests that compare exported MCP tools against the shared contract and docs.
5. Improve the CLI so bash scripts can use it reliably: predictable stdout for machine-readable modes, useful human output for manual modes, nonzero exits on failure, and no hidden state outside `NARRATIONLAYER_DATA_DIR` except documented defaults.
6. Add privacy and profile handling: `profiles.example.yaml` should be public-safe; `profiles.local.yaml` and any references to private cloned voices stay ignored. Never hardcode Theo or private assets in code.
7. Add tests for CLI, job-store, renderer interface, fake renderer word timings, MCP tool handlers, schema/tool drift, and mocked VoiceLayer adapter behavior. No tests should require the real TTS daemon.
8. Update docs so a future Codex in a new isolated Happy Campr user can install, run doctor, run fake smoke, configure a local profile, and call the CLI/MCP without guessing.

## Verification Gate

Before claiming done:

- Run `bun install` if needed, unless the ADR changes runtime and explains why.
- Run `bun test`, or the runtime-equivalent full test command if changed by ADR.
- Run the doctor command.
- Run a fake end-to-end smoke with `NARRATIONLAYER_DATA_DIR` set to a temp dir: create-job, render, status; verify status is done, `DONE` exists, manifest exists, `audio_path` and `words_path` are non-empty.
- Run MCP smoke coverage: verify create/status/result/list behavior either through the MCP server or direct handler tests.
- Run the drift test: verify MCP tool names/descriptions/input schemas match the shared contract and docs.
- Check `git ls-files` for private audio, reference clips, real transcripts, `profiles.local.yaml`, `.env`, tokens, or secrets. There should be no matches.
- Check `git status`. It must be clean or the final answer must list exactly what remains uncommitted and why.

## Style Constraints

- Stable contracts over cleverness.
- Schemas and typed objects over ad hoc strings.
- Small service boundary; do not build a dashboard here.
- Do not create live dashboard orchestration unless explicitly asked.
- Do not push unless Etan explicitly asks.
