# ADR: Runtime for NarrationLayer v1

## Decision

Keep TypeScript/Bun for v1.

## Why

- The existing scaffold, tests, CLI, and MCP server are already TypeScript/Bun.
- Bun gives fast local tests and simple single-runtime CLI execution.
- The VoiceLayer/Qwen3 integration is an HTTP adapter, so NarrationLayer does not
  need Python model dependencies in-process.
- MCP and JSON schema contract tests are straightforward in TypeScript.
- A future packaged binary or MCP install can wrap the Bun entrypoints without a
  rewrite.

## Rejected Options

- Python: useful for model code, but migration would add packaging churn and
  duplicate VoiceLayer's local daemon responsibilities.
- Rust: attractive for distribution, but unnecessary for this small IO-bound
  service and slower to iterate with MCP/schema tests.
- Split runtimes: not needed while the only non-TypeScript dependency is already
  isolated behind the local VoiceLayer HTTP daemon.
