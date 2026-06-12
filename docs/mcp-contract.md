# MCP Contract

The MCP server runs on stdin/stdout and follows JSON-RPC 2.0 with MCP tool calls.

## Tools

### `create_narration_job`

- Input:
  - `job` (object) or
  - `job_path` (string path to narration-job JSON)
- Output:
  - `job_id`
  - `job_path`
  - `status_path`
  - `manifest_path`

### `get_narration_status`

- Input:
  - `job_id` (string)
- Output:
  - `status` payload from `status.json`

### `get_narration_result`

- Input:
  - `job_id` (string)
- Output:
  - job record + manifest payload

### `list_narration_jobs`

- Input: empty
- Output:
  - list of job IDs

## Error contract

Errors are returned as JSON-RPC `error` entries with human-readable messages.
