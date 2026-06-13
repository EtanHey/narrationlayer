# Qwen3-TTS LoRA Workflow

This repo stays public-safe. Keep curated clips, transcripts, trained adapters,
and model checkpoints outside git.

## Goal

Build a private local voice profile that uses Qwen3-TTS plus a small trained
LoRA adapter instead of relying only on reference-audio conditioning.

## Local Workstreams

1. Curate a private dataset of short, clean clips with exact transcripts.
   Prefer natural cadence, breath, punctuation, and representative vocabulary
   over bulk duration.
2. Prepare Qwen3 raw JSONL from private metadata:
   `bun run narrationlayer qwen3-lora-prepare <config.json> --json`.
3. Preflight the generated run directory:
   `bun run narrationlayer qwen3-lora-preflight <run-dir> --json`.
4. Train a Qwen3-TTS-specific LoRA with the private dataset. The resulting
   adapter is only compatible with the matching Qwen3-TTS base/checkpoint.
5. Expose the trained profile to NarrationLayer through either:
   - a VoiceLayer Qwen3 daemon contract that accepts LoRA path/scale and
     returns `lora_applied: true`, or
   - an ignored `external-command` profile that calls a local LoRA-capable runner.
6. Compare the trained adapter against current Qwen3 reference conditioning on
   the same scripts. Qwen3 current is the baseline; the LoRA path is the primary
   improvement path.

## Current Contract Status

The existing `voicelayer-qwen3` adapter sends only:

- `text`
- `reference_wav`
- `reference_text`
- optional `lora_adapter_path`
- optional `lora_scale`

When `lora_adapter_path` is configured, the adapter fails closed unless the
daemon response includes `lora_applied: true`. This prevents silent no-op renders
where the old Qwen3 voice is used while the job looks like a LoRA render.

## Dataset Preparation

Private config shape:

```json
{
  "train_metadata_csv": "/private/voice/training-clips/metadata_train.csv",
  "eval_metadata_csv": "/private/voice/training-clips/metadata_eval.csv",
  "clips_dir": "/private/voice/training-clips",
  "ref_audio": "/private/voice/reference-clips/ref.wav",
  "output_dir": "/private/qwen3-lora/run-001",
  "speaker_name": "speaker_1",
  "copy_audio": false,
  "qwen_dir": "/private/tools/Qwen3-TTS",
  "lora_tools_dir": "/private/tools/qwen3-tts-lora-finetuning",
  "python_bin": "python",
  "device": "cuda:0",
  "batch_size": 4,
  "learning_rate": "2e-6",
  "epochs": 10,
  "lora_scale": 0.3
}
```

The command writes:

- `train_raw.jsonl`
- `val_raw.jsonl`
- `qwen3-lora.env`
- `prepare-qwen3-data.sh`
- `train-qwen3-lora.sh`

`qwen3-lora-preflight` checks the generated dataset counts, audio/ref_audio
paths, 24 kHz sample rates, patched Qwen3-TTS files, companion LoRA launcher,
Python imports, and runtime availability for the configured device before
training starts.

## Apple Silicon Tracks

The public Qwen3-TTS fine-tuning examples are CUDA-first. NarrationLayer keeps
that path configurable, but it should not be treated as the only possible local
path.

- `device: "cuda:0"` keeps the upstream-style defaults:
  `ATTN_IMPL=flash_attention_2`, `MIXED_PRECISION=bf16`, batch size `4`.
- `device: "mps"` generates conservative Mac probe defaults:
  `ATTN_IMPL=eager`, `MIXED_PRECISION=no`, `TORCH_DTYPE=float32`, batch size `1`,
  gradient accumulation `16`, LoRA rank `8`.

The MPS path is an experimental bridge for proving the existing PyTorch training
loop can execute on Apple Silicon. The longer-term native path is an MLX trainer
that ports the Qwen3-TTS SFT loss and LoRA adapter save/load flow directly to
Apple's MLX stack.

## Candidate Commands

```bash
bun run narrationlayer qwen3-lora-prepare examples/qwen3-lora-prepare.example.json --json
bun run narrationlayer qwen3-lora-preflight /private/qwen3-lora/run-001 --json
```

Use a private copy of the example config. Do not commit generated JSONL, clips,
trained adapters, or checkpoints.
