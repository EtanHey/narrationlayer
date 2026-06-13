# MCP Contract

The MCP server runs on stdin/stdout and follows JSON-RPC 2.0 with MCP tool calls.

## Tools

### `create_narration_job`

Create a queued narration job from an inline job or job JSON path.

- Input:
  - `job` (object) or
  - `job_path` (string path to narration-job JSON)
- Output:
  - `job_id`
  - `job_path`
  - `status_path`
  - `manifest_path`

### `render_narration_job`

Render a queued narration job and return final status plus manifest.

- Input:
  - `job_id` (string)
- Output:
  - `status`
  - `manifest`

### `get_narration_status`

Get stable status for one narration job.

- Input:
  - `job_id` (string)
- Output:
  - `status` payload from `status.json`
  - `done`
  - `failed`
  - `manifest_exists`
  - `manifest`

### `get_narration_result`

Get the stored job and render manifest for one narration job.

- Input:
  - `job_id` (string)
- Output:
  - `job`
  - `manifest`

### `list_narration_jobs`

List stored narration job IDs.

- Input: empty
- Output:
  - list of job IDs

## Error contract

Errors are returned as JSON-RPC `error` entries with human-readable messages.

## Drift Contract

`src/contract.ts` is the shared MCP source of truth. `docs/mcp-tools.json` must
match it exactly, and this Markdown file must include each shared tool name and
description.
