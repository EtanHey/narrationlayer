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
    mkdirSync(path.join(qwenDir, "qwen_tts", "core", "models"), { recursive: true });
    mkdirSync(path.join(loraToolsDir, "scripts"), { recursive: true });
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(qwenDir, "finetuning", "prepare_data.py"), "# prepare\n");
    writeFileSync(
      path.join(qwenDir, "finetuning", "sft_12hz_lora.py"),
      [
        "parser.add_argument('--torch_dtype')",
        "parser.add_argument('--device')",
        "parser.add_argument('--attn_implementation', default='eager')",
        "input_text_embedding = model.talker.text_projection(model.talker.model.text_embedding(input_text_ids))",
        "assert input_text_embedding.shape == input_codec_embedding.shape",
        "outputs = model.talker(inputs_embeds=input_embeddings, attention_mask=attention_mask, labels=codec_0_labels)",
        "hidden_states = outputs.hidden_states[0][-1][:, :-1, :]",
        "talker_hidden_states = hidden_states[codec_mask[:, 1:]]",
      ].join("\n"),
    );
    writeFileSync(
      path.join(qwenDir, "qwen_tts", "core", "models", "modeling_qwen3_tts.py"),
      "loss = self.loss_function(logits=logits, labels=None, shift_labels=labels.contiguous(), vocab_size=self.config.vocab_size)\n",
    );
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

test("Qwen3 LoRA preparation auto-detects Apple Silicon and avoids silent CUDA defaults", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");
  const originalDevice = process.env.DEVICE;
  const originalQwenDevice = process.env.QWEN3_LORA_DEVICE;

  try {
    delete process.env.DEVICE;
    delete process.env.QWEN3_LORA_DEVICE;
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(clipsDir, "clip-1.wav"), "fake wav");
    writeFileSync(refAudioPath, "fake ref wav");
    writeFileSync(trainMetadataPath, "audio_file|text|speaker_name\nclip-1.wav|First transcript.|THEO\n");

    const result = await prepareQwen3LoraDataset({
      train_metadata_csv: trainMetadataPath,
      clips_dir: clipsDir,
      ref_audio: refAudioPath,
      output_dir: outputDir,
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
    expect(trainScript).toContain('--device "$DEVICE"');
    expect(trainScript).toContain('ATTN_IMPL="${ATTN_IMPL:-eager}"');
    expect(trainScript).not.toContain('flash_attention_2');
    expect(result.commands.train_lora).toContain("DEVICE='mps'");
    expect(result.commands.train_lora).toContain("ATTN_IMPL='eager'");
    expect(result.commands.train_lora).toContain("TORCH_DTYPE='float32'");
  } finally {
    if (originalDevice === undefined) {
      delete process.env.DEVICE;
    } else {
      process.env.DEVICE = originalDevice;
    }
    if (originalQwenDevice === undefined) {
      delete process.env.QWEN3_LORA_DEVICE;
    } else {
      process.env.QWEN3_LORA_DEVICE = originalQwenDevice;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Qwen3 LoRA preparation preserves explicit CUDA env path", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");
  const cudaDevice = ["cuda", "0"].join(":");

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
      device: cudaDevice,
    });

    const envFile = await Bun.file(path.join(outputDir, "qwen3-lora.env")).text();
    expect(envFile).toContain(`DEVICE=${cudaDevice}`);
    expect(envFile).toContain("ATTN_IMPL=flash_attention_2");
    expect(envFile).toContain("TORCH_DTYPE=bfloat16");
    expect(result.commands.train_lora).toContain(`DEVICE='${cudaDevice}'`);

    const trainScript = await Bun.file(result.train_script_path).text();
    expect(trainScript).toContain('ATTN_IMPL="${ATTN_IMPL:-flash_attention_2}"');
    expect(trainScript).toContain('--device "$DEVICE"');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Qwen3 LoRA preflight asserts upstream label-shift and text_projection fixes", async () => {
  const dataDir = createTempDir();
  const clipsDir = path.join(dataDir, "clips");
  const outputDir = path.join(dataDir, "qwen3-lora");
  const qwenDir = path.join(dataDir, "tools", "Qwen3-TTS");
  const loraToolsDir = path.join(dataDir, "tools", "qwen3-tts-lora-finetuning");
  const trainMetadataPath = path.join(dataDir, "metadata_train.csv");
  const refAudioPath = path.join(dataDir, "ref.wav");

  try {
    mkdirSync(path.join(qwenDir, "finetuning"), { recursive: true });
    mkdirSync(path.join(qwenDir, "qwen_tts", "core", "models"), { recursive: true });
    mkdirSync(path.join(loraToolsDir, "scripts"), { recursive: true });
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(qwenDir, "finetuning", "prepare_data.py"), "# prepare\n");
    writeFileSync(
      path.join(qwenDir, "finetuning", "sft_12hz_lora.py"),
      [
        "parser.add_argument('--torch_dtype')",
        "parser.add_argument('--device')",
        "parser.add_argument('--attn_implementation', default='eager')",
        "input_text_embedding = model.talker.text_projection(model.talker.model.text_embedding(input_text_ids))",
        "assert input_text_embedding.shape == input_codec_embedding.shape",
        "outputs = model.talker(inputs_embeds=input_embeddings, attention_mask=attention_mask, labels=codec_0_labels)",
        "hidden_states = outputs.hidden_states[0][-1][:, :-1, :]",
        "talker_hidden_states = hidden_states[codec_mask[:, 1:]]",
      ].join("\n"),
    );
    writeFileSync(
      path.join(qwenDir, "qwen_tts", "core", "models", "modeling_qwen3_tts.py"),
      "loss = self.loss_function(logits=logits, labels=None, shift_labels=labels.contiguous(), vocab_size=self.config.vocab_size)\n",
    );
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
      device: "mps",
    });

    const result = await preflightQwen3LoraRun({
      run_dir: outputDir,
      python_bin: path.join(dataDir, "missing-python"),
    });

    expect(result.checks.find((check) => check.id === "qwen.sft_lora_mps_patch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "qwen.sft_lora_attention_patch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "qwen.sft_lora_label_shift_patch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "qwen.modeling_label_shift_patch")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "qwen.sft_lora_text_projection_patch")?.status).toBe("pass");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
