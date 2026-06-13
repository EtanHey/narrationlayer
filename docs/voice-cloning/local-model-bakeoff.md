# Local Model Bakeoff

This plan is for free/local-first voice generation. Keep private reference media,
transcripts, model checkpoints, and trained adapters outside git.

## Candidate Set

| Candidate | First use | Training/adaptation stance | Current verdict |
| --- | --- | --- | --- |
| Qwen3-TTS current | Existing `voicelayer-qwen3` profile with reference clip/text | Reference-conditioned baseline | Selected baseline. |
| Qwen3-TTS LoRA | Private LoRA-capable Qwen runner or daemon contract with `lora_applied: true` | Qwen-specific LoRA; not transferable to other models | Primary improvement path. |
| F5-TTS MLX | `external-command` profile around a local F5 MLX runner | Start zero-shot; only pursue F5-specific training if it wins | Bakeoff candidate. |
| IndexTTS2 | `external-command` profile around a local IndexTTS2 runner | Start zero-shot/reference-conditioned; LoRA is not a first-path assumption | Bakeoff candidate, Apple Silicon feasibility unclear. |
| VoxCPM2 | `external-command` profile around a local VoxCPM2 runner | Official LoRA/full fine-tune docs exist; adapter is still model-specific | Add to first bakeoff. |

## Why VoxCPM2 Is Included

The earlier research centered on Qwen3, F5, and IndexTTS2. A current check found
VoxCPM2 as a newer local/free candidate with official claims that matter for this
project: Apple Silicon MPS support, voice cloning, LoRA/full fine-tuning
documentation, Apache-2.0 licensing, 48 kHz output, and multilingual coverage
including Hebrew.

The local smoke check selected current Qwen3 as the clear baseline. VoxCPM2 can
remain a reference, but active investment should go into Qwen3 LoRA unless the
user explicitly reopens model selection.

## Adapter Contract

Use `external-command` for model runners that are not native NarrationLayer
renderers. Private profiles provide:

- `command`
- `args[]`
- `cwd`
- `timeout_ms`
- `output_ext`
- `reference_clip`
- `reference_text` or `reference_text_path`
- `timing_backend`

Supported placeholders:

- `{output_path}`
- `{script}`
- `{segment_id}`
- `{job_id}`
- `{voice_profile}`
- `{reference_clip}`
- `{reference_text}`
- `{reference_text_path}`

## Run Shape

```bash
bun run narrationlayer bakeoff-create examples/local-bakeoff-template.json --json
```

Render the created jobs after local private profiles exist. Compare the rendered
dashboards and audio on the same scripts.

## Decision Rule

Score each candidate on:

- punctuation and pause respect
- natural breath/cadence
- onset clipping
- tail noise or mechanical artifacts
- word truncation
- speaker similarity
- long-form stability
- teleprompter alignment

Only investigate model-specific LoRA/fine-tuning for F5, IndexTTS2, or VoxCPM2
after that model beats current Qwen3 on zero-shot/reference-conditioned output.
