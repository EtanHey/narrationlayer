import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { preflightQwen3LoraRun, prepareQwen3LoraDataset } from "../src/qwen3-lora.js";

function createTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "narrationlayer-qwen3-lora-"));
}

test("Qwen3 LoRA preparation converts XTTS metadata into official raw JSONL", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const evalMetadataPath = path.join(dataDir, "metadata_eval.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");
  await Bun.$`mkdir -p ${clipsDir}`.quiet();
  writeFileSync(path.join(clipsDir, "clip-1.wav"), "fake wav");
  writeFileSync(path.join(clipsDir, "clip-2.wav"), "fake wav");
  writeFileSync(refAudioPath, "fake ref wav");
  writeFileSync(
    trainMetadataPath,
    [
      "audio_file|text|speaker_name",
      "clip-1.wav|First transcript with punctuation.|THEO",
      "missing.wav|Missing audio should be skipped.|THEO",
    ].join("\n"),
  );
  writeFileSync(evalMetadataPath, "audio_file|text|speaker_name\nclip-2.wav|Eval transcript.|THEO\n");

  try {
    const result = await prepareQwen3LoraDataset({
      train_metadata_csv: trainMetadataPath,
      eval_metadata_csv: evalMetadataPath,
      clips_dir: clipsDir,
      ref_audio: refAudioPath,
      output_dir: outputDir,
      speaker_name: "theo_lora",
      copy_audio: false,
      init_model_path: "Custom/Qwen3-TTS-Base",
    });

    expect(result.train_count).toBe(1);
    expect(result.eval_count).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(result.commands.prepare_train).toContain("prepare_data.py");
    expect(result.commands.train_lora).toContain("train-qwen3-lora.sh");
    expect(result.commands.train_lora).toContain("INIT_MODEL_PATH='Custom/Qwen3-TTS-Base'");

    const trainJsonl = (await Bun.file(result.train_raw_jsonl).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const evalJsonl = (await Bun.file(result.eval_raw_jsonl).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trainJsonl).toEqual([
      {
        audio: path.join(clipsDir, "clip-1.wav"),
        text: "First transcript with punctuation.",
        ref_audio: refAudioPath,
      },
    ]);
    expect(evalJsonl).toEqual([
      {
        audio: path.join(clipsDir, "clip-2.wav"),
        text: "Eval transcript.",
        ref_audio: refAudioPath,
      },
    ]);

    const envFile = await Bun.file(path.join(outputDir, "qwen3-lora.env")).text();
    expect(envFile).toContain("SPEAKER_NAME=theo_lora");
    expect(envFile).toContain("LORA_SCALE=0.3");
    expect(envFile).toContain("PYTHON_BIN=python");
    const trainScript = await Bun.file(path.join(outputDir, "train-qwen3-lora.sh")).text();
    expect(trainScript).toContain('--init_model_path "$INIT_MODEL_PATH"');
    expect(trainScript).toContain('"$PYTHON_BIN" "$QWEN_DIR/finetuning/sft_12hz_lora.py"');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Qwen3 LoRA preflight validates prepared files and reports runtime blockers", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const qwenDir = path.join(dataDir, "tools", "Qwen3-TTS");
  const loraToolsDir = path.join(dataDir, "tools", "qwen3-tts-lora-finetuning");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");

  try {
    mkdirSync(path.join(qwenDir, "finetuning"), { recursive: true });
    mkdirSync(path.join(loraToolsDir, "scripts"), { recursive: true });
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(qwenDir, "finetuning", "prepare_data.py"), "# prepare\n");
    writeFileSync(path.join(qwenDir, "finetuning", "sft_12hz_lora.py"), "# train\n");
    writeFileSync(path.join(loraToolsDir, "scripts", "run_lora_train.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(path.join(clipsDir, "clip-1.wav"), "fake wav");
    writeFileSync(refAudioPath, "fake ref wav");
    writeFileSync(trainMetadataPath, "audio_file|text|speaker_name\nclip-1.wav|First transcript.|THEO\n");

    await prepareQwen3LoraDataset({
      train_metadata_csv: trainMetadataPath,
      clips_dir: clipsDir,
      ref_audio: refAudioPath,
      output_dir: outputDir,
      qwen_dir: qwenDir,
      lora_tools_dir: loraToolsDir,
    });

    const result = await preflightQwen3LoraRun({
      run_dir: outputDir,
      python_bin: path.join(dataDir, "missing-python"),
    });

    expect(result.ready).toBeFalse();
    expect(result.counts.train_raw_rows).toBe(1);
    expect(result.counts.missing_audio_rows).toBe(0);
    expect(result.checks.find((check) => check.id === "dataset.train_raw")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "runtime.python")?.status).toBe("fail");
    expect(result.blockers.some((blocker) => blocker.includes("Python runtime"))).toBeTrue();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Qwen3 LoRA preparation uses MPS-safe training defaults", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");

  try {
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(clipsDir, "clip-1.wav"), "fake wav");
    writeFileSync(refAudioPath, "fake ref wav");
    writeFileSync(trainMetadataPath, "audio_file|text|speaker_name\nclip-1.wav|First transcript.|THEO\n");

    const result = await prepareQwen3LoraDataset({
      train_metadata_csv: trainMetadataPath,
      clips_dir: clipsDir,
      ref_audio: refAudioPath,
      output_dir: outputDir,
      device: "mps",
    });

    const envFile = await Bun.file(path.join(outputDir, "qwen3-lora.env")).text();
    expect(envFile).toContain("DEVICE=mps");
    expect(envFile).toContain("BATCH_SIZE=1");
    expect(envFile).toContain("GRAD_ACCUM_STEPS=16");
    expect(envFile).toContain("MIXED_PRECISION=no");
    expect(envFile).toContain("ATTN_IMPL=eager");
    expect(envFile).toContain("TORCH_DTYPE=float32");
    expect(envFile).toContain("LORA_RANK=8");
    expect(envFile).toContain("LORA_ALPHA=16");

    const trainScript = await Bun.file(result.train_script_path).text();
    expect(trainScript).toContain('--torch_dtype "$TORCH_DTYPE"');
    expect(result.commands.train_lora).toContain("ATTN_IMPL='eager'");
    expect(result.commands.train_lora).toContain("TORCH_DTYPE='float32'");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
