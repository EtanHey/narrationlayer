# Job Manifest

`manifest.json` is the canonical post-render artifact for each job.

Top-level fields:

- `job_id`
- `created_at`
- `voice_profile`
- `renderer`
- `segments[]`
- `segments[].id`
- `segments[].title`
- `segments[].script`
- `segments[].audio_path`
- `segments[].duration_seconds`
- `segments[].words_path`
- `segments[].status`
- `segments[].error` (optional, failed segment only)
- `total_duration_seconds`
- `artifacts_dir`
- `errors[]`

### Segment status meaning

- `pending` — not yet rendered
- `rendered` — rendered successfully
- `failed` — renderer returned an error
- `skipped` — intentionally skipped by policy

`words_path` points at the teleprompter word timing JSON for that segment.
