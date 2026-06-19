# Qwen3 LoRA GATE-N1 Device Evidence

Status: item #3 device blocker evidence, public-safe. No private Theo audio or
private transcripts are included here.

## PyTorch MPS Arm

- Device default: generated Qwen3 LoRA runs now auto-detect Apple Silicon as
  `mps`; non-CUDA generated scripts default to `ATTN_IMPL=eager` and
  `TORCH_DTYPE=float32`.
- CUDA path: explicit config/env device values still preserve the CUDA path and
  keep FlashAttention as a CUDA-only dependency check.
- Preflight run:
  `bun run narrationlayer qwen3-lora-preflight examples.local/qwen3-lora/public-mps-probe/run --json`
- Preflight verdict: `ready: true`; `runtime.mps`,
  `qwen.sft_lora_mps_patch`, `qwen.sft_lora_attention_patch`,
  `qwen.sft_lora_label_shift_patch`, `qwen.modeling_label_shift_patch`, and
  `qwen.sft_lora_text_projection_patch` all passed.
- Tiny train run:
  `sft_12hz_lora.py --device mps --attn_implementation eager --torch_dtype float32`
- Tiny train verdict: model loaded on `mps:0` and produced two finite losses:
  `7.8739`, `7.8257`.

## Native MLX Arm

- Package: `mlx-tune[audio]` 0.5.1 in ignored venv
  `examples.local/venvs/mlx-tune`.
- API verified: `FastTTSModel`, `TTSSFTTrainer`, `TTSSFTConfig`,
  `TTSDataCollator`.
- Requested model: `Qwen/Qwen3-TTS-12Hz-1.7B-Base`.
- First attempt: model loaded and LoRA attached, then failed because the sample
  used an audio path where the collator expected an audio array.
- Second attempt: loaded the same public synthetic WAVs into arrays and ran
  `TTSSFTTrainer` for one step.
- Native MLX verdict: loads and steps on Apple Silicon; one-step loss `1.8281`.

## Upstream Fixes

- Label alignment live-verified against QwenLM/Qwen3-TTS PR #278: pass
  unshifted tensors at the trainer call site and route code-predictor labels
  through `shift_labels`.
- `text_projection` fix live-verified against the instavar companion repo notes:
  project text embeddings before masking and assert text/codec embedding shape
  equality before summing.

## Local Artifacts

- Public synthetic probe data is ignored under
  `examples.local/qwen3-lora/public-mps-probe/`.
- The reusable upstream patch is tracked at
  `patches/qwen3-tts-sft-12hz-lora-mps-device.patch`.
