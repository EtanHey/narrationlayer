import { access, chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface Qwen3LoraPrepareInput {
  train_metadata_csv: string;
  eval_metadata_csv?: string;
  clips_dir: string;
  ref_audio: string;
  output_dir: string;
  speaker_name?: string;
  copy_audio?: boolean;
  qwen_dir?: string;
  lora_tools_dir?: string;
  python_bin?: string;
  tokenizer_model_path?: string;
  init_model_path?: string;
  device?: string;
  batch_size?: number;
  learning_rate?: string;
  epochs?: number;
  gradient_accumulation_steps?: number;
  mixed_precision?: string;
  attention_implementation?: string;
  torch_dtype?: string;
  lora_rank?: number;
  lora_alpha?: number;
  lora_dropout?: number;
  lora_scale?: number;
}

export interface Qwen3LoraSkippedRow {
  metadata_path: string;
  line: number;
  audio_file: string;
  reason: string;
}

export interface Qwen3LoraPrepareResult {
  output_dir: string;
  train_raw_jsonl: string;
  eval_raw_jsonl: string;
  train_count: number;
  eval_count: number;
  skipped: Qwen3LoraSkippedRow[];
  env_path: string;
  prepare_script_path: string;
  train_script_path: string;
  commands: {
    prepare_train: string;
    prepare_eval: string;
    train_lora: string;
  };
}

export type Qwen3LoraPreflightStatus = "pass" | "warn" | "fail";

export interface Qwen3LoraPreflightCheck {
  id: string;
  status: Qwen3LoraPreflightStatus;
  detail: string;
}

export interface Qwen3LoraPreflightInput {
  run_dir: string;
  python_bin?: string;
}

export interface Qwen3LoraPreflightResult {
  run_dir: string;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  counts: {
    train_raw_rows: number;
    eval_raw_rows: number;
    invalid_jsonl_rows: number;
    missing_audio_rows: number;
    sample_rate_mismatch_files: number;
    sample_rate_unknown_files: number;
  };
  checks: Qwen3LoraPreflightCheck[];
  commands: {
    prepare_script: string;
    train_script: string;
  };
}

interface MetadataRow {
  audio_file: string;
  text: string;
  line: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: keyof Qwen3LoraPrepareInput): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`qwen3-lora config requires ${String(key)}`);
  }
  return value.trim();
}

function optionalString(raw: Record<string, unknown>, key: keyof Qwen3LoraPrepareInput): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveNumber(raw: Record<string, unknown>, key: keyof Qwen3LoraPrepareInput): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDevice(value: string): string {
  return value.trim().toLowerCase();
}

function detectDefaultDevice(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "mps";
  }
  return "cpu";
}

function resolveTrainingDevice(value: string | undefined): string {
  const explicit = value || process.env.QWEN3_LORA_DEVICE || process.env.DEVICE;
  return normalizeDevice(explicit || detectDefaultDevice());
}

function isMpsDevice(device: string): boolean {
  return normalizeDevice(device) === "mps";
}

function isCudaDevice(device: string): boolean {
  return normalizeDevice(device).startsWith("cuda");
}

function defaultBatchSizeForDevice(device: string): number {
  return isMpsDevice(device) ? 1 : 4;
}

function defaultGradAccumForDevice(device: string): number {
  return isMpsDevice(device) ? 16 : 4;
}

function defaultMixedPrecisionForDevice(device: string): string {
  return isMpsDevice(device) ? "no" : "bf16";
}

function defaultAttentionForDevice(device: string): string {
  return isCudaDevice(device) ? "flash_attention_2" : "eager";
}

function defaultTorchDtypeForDevice(device: string): string {
  return isMpsDevice(device) || normalizeDevice(device) === "cpu" ? "float32" : "bfloat16";
}

function resolveConfigPath(value: string | undefined, baseDir: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "~" || value.startsWith("~/")) {
    return path.join(process.env.HOME || "~", value.slice(value === "~" ? 1 : 2));
  }
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellEnvValue(value: string | number): string {
  const text = String(value).replace(/\n/g, " ");
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : shellQuote(text);
}

function normalizeSpeakerName(value: string | undefined): string {
  const normalized = (value || "speaker_1")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return normalized || "speaker_1";
}

function parseMetadata(content: string, metadataPath: string): MetadataRow[] {
  const rows: MetadataRow[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fields = line.split("|");
    if (index === 0 && fields[0] === "audio_file") {
      continue;
    }
    if (fields.length < 2) {
      continue;
    }
    const audioFile = fields[0]?.trim();
    const textFields = fields.length >= 3 ? fields.slice(1, -1) : fields.slice(1);
    const text = textFields.join("|").trim();
    if (!audioFile || !text) {
      continue;
    }
    rows.push({
      audio_file: audioFile,
      text,
      line: index + 1,
    });
  }
  if (rows.length === 0) {
    throw new Error(`No usable metadata rows found in ${metadataPath}`);
  }
  return rows;
}

async function canRead(pathName: string): Promise<boolean> {
  try {
    await readFile(pathName);
    return true;
  } catch {
    return false;
  }
}

async function exists(pathName: string): Promise<boolean> {
  try {
    await access(pathName);
    return true;
  } catch {
    return false;
  }
}

async function isFile(pathName: string): Promise<boolean> {
  try {
    return (await stat(pathName)).isFile();
  } catch {
    return false;
  }
}

async function writeJsonlFromMetadata(args: {
  metadataPath: string;
  clipsDir: string;
  refAudio: string;
  outputPath: string;
  outputAudioDir?: string;
  skipped: Qwen3LoraSkippedRow[];
}): Promise<number> {
  const rows = parseMetadata(await readFile(args.metadataPath, "utf8"), args.metadataPath);
  const lines: string[] = [];
  for (const row of rows) {
    const sourceAudio = path.isAbsolute(row.audio_file) ? row.audio_file : path.resolve(args.clipsDir, row.audio_file);
    if (!(await canRead(sourceAudio))) {
      args.skipped.push({
        metadata_path: args.metadataPath,
        line: row.line,
        audio_file: row.audio_file,
        reason: "audio_not_found",
      });
      continue;
    }
    let audioPath = sourceAudio;
    if (args.outputAudioDir) {
      await mkdir(args.outputAudioDir, { recursive: true });
      audioPath = path.join(args.outputAudioDir, path.basename(row.audio_file));
      await copyFile(sourceAudio, audioPath, constants.COPYFILE_FICLONE).catch(() => copyFile(sourceAudio, audioPath));
    }
    lines.push(
      JSON.stringify({
        audio: audioPath,
        text: row.text,
        ref_audio: args.refAudio,
      }),
    );
  }
  await writeFile(args.outputPath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
  return lines.length;
}

function buildCommands(args: {
  qwenDir: string;
  loraToolsDir: string;
  pythonBin: string;
  tokenizerModelPath: string;
  initModelPath: string;
  device: string;
  trainRawJsonl: string;
  trainJsonl: string;
  evalRawJsonl: string;
  evalJsonl: string;
  outputDir: string;
  speakerName: string;
  batchSize: number;
  learningRate: string;
  epochs: number;
  gradAccumSteps: number;
  mixedPrecision: string;
  attentionImplementation: string;
  torchDtype: string;
  loraRank: number;
  loraAlpha: number;
  loraDropout: number;
}): Qwen3LoraPrepareResult["commands"] {
  return {
    prepare_train: [
      shellQuote(args.pythonBin),
      shellQuote(path.join(args.qwenDir, "finetuning", "prepare_data.py")),
      "--device",
      shellQuote(args.device),
      "--tokenizer_model_path",
      shellQuote(args.tokenizerModelPath),
      "--input_jsonl",
      shellQuote(args.trainRawJsonl),
      "--output_jsonl",
      shellQuote(args.trainJsonl),
    ].join(" "),
    prepare_eval: [
      shellQuote(args.pythonBin),
      shellQuote(path.join(args.qwenDir, "finetuning", "prepare_data.py")),
      "--device",
      shellQuote(args.device),
      "--tokenizer_model_path",
      shellQuote(args.tokenizerModelPath),
      "--input_jsonl",
      shellQuote(args.evalRawJsonl),
      "--output_jsonl",
      shellQuote(args.evalJsonl),
    ].join(" "),
    train_lora: [
      "PYTHON_BIN=",
      shellQuote(args.pythonBin),
      " QWEN_DIR=",
      shellQuote(args.qwenDir),
      " TRAIN_JSONL=",
      shellQuote(args.trainJsonl),
      " VAL_JSONL=",
      shellQuote(args.evalJsonl),
      " OUTPUT_DIR=",
      shellQuote(path.join(args.outputDir, "adapter")),
      " DEVICE=",
      shellQuote(args.device),
      " INIT_MODEL_PATH=",
      shellQuote(args.initModelPath),
      " LR=",
      shellQuote(args.learningRate),
      " EPOCHS=",
      shellQuote(String(args.epochs)),
      " BATCH_SIZE=",
      shellQuote(String(args.batchSize)),
      " GRAD_ACCUM_STEPS=",
      shellQuote(String(args.gradAccumSteps)),
      " MIXED_PRECISION=",
      shellQuote(args.mixedPrecision),
      " ATTN_IMPL=",
      shellQuote(args.attentionImplementation),
      " TORCH_DTYPE=",
      shellQuote(args.torchDtype),
      " LORA_RANK=",
      shellQuote(String(args.loraRank)),
      " LORA_ALPHA=",
      shellQuote(String(args.loraAlpha)),
      " LORA_DROPOUT=",
      shellQuote(String(args.loraDropout)),
      " SPEAKER_NAME=",
      shellQuote(args.speakerName),
      " bash ",
      shellQuote(path.join(args.outputDir, "train-qwen3-lora.sh")),
    ].join(""),
  };
}

function envLine(key: string, value: string | number): string {
  return `${key}=${shellEnvValue(value)}`;
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    parsed[match[1]] = parseEnvValue(match[2]);
  }
  return parsed;
}

function parseTrailingJsonObject(content: string): unknown {
  const trimmed = content.trim();
  for (let start = trimmed.lastIndexOf("{"); start >= 0; start = trimmed.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Keep walking backward; imported Python modules may print banners before JSON.
    }
  }
  throw new Error("No JSON object found");
}

interface JsonlAudit {
  count: number;
  invalid: number;
  missingAudio: number;
  audioPaths: string[];
}

async function auditJsonl(pathName: string): Promise<JsonlAudit> {
  if (!(await isFile(pathName))) {
    return { count: 0, invalid: 0, missingAudio: 0, audioPaths: [] };
  }
  let count = 0;
  let invalid = 0;
  let missingAudio = 0;
  const audioPaths: string[] = [];
  const content = await readFile(pathName, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    count += 1;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) {
        invalid += 1;
        continue;
      }
      const audio = typeof parsed.audio === "string" ? parsed.audio : "";
      const refAudio = typeof parsed.ref_audio === "string" ? parsed.ref_audio : "";
      if (audio) {
        audioPaths.push(audio);
      }
      if (refAudio) {
        audioPaths.push(refAudio);
      }
      if (!audio || !(await isFile(audio)) || !refAudio || !(await isFile(refAudio))) {
        missingAudio += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  return { count, invalid, missingAudio, audioPaths };
}

async function getAudioSampleRate(pathName: string): Promise<number | undefined> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        pathName,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } catch {
    return undefined;
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    return undefined;
  }
  const parsed = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function auditSampleRates(
  audioPaths: string[],
  expectedHz: number,
): Promise<{ checked: number; mismatch: number; unknown: number }> {
  let checked = 0;
  let mismatch = 0;
  let unknown = 0;
  for (const audioPath of audioPaths) {
    const sampleRate = await getAudioSampleRate(audioPath);
    if (!sampleRate) {
      unknown += 1;
      continue;
    }
    checked += 1;
    if (sampleRate !== expectedHz) {
      mismatch += 1;
    }
  }
  return { checked, mismatch, unknown };
}

async function runPythonRuntimeCheck(args: {
  pythonBin: string;
  qwenDir: string;
  device: string;
}): Promise<{ ok: boolean; detail: string; missing: string[]; cudaAvailable?: boolean; mpsAvailable?: boolean }> {
  const needsFlashAttention = isCudaDevice(args.device);
  const needsFlashAttentionPython = needsFlashAttention ? "True" : "False";
  const code = `
import importlib, json

modules = ["qwen_tts", "peft", "torch", "transformers", "accelerate", "safetensors", "soundfile", "librosa"]
if ${needsFlashAttentionPython}:
    modules.append("flash_attn")
details = {}
missing = []
for module in modules:
    try:
        importlib.import_module(module)
        details[module] = "ok"
    except Exception as exc:
        details[module] = type(exc).__name__ + ": " + str(exc)[:200]
        missing.append(module)

cuda_available = None
mps_available = None
try:
    import torch
    cuda_available = bool(torch.cuda.is_available())
    mps_available = bool(torch.backends.mps.is_available())
except Exception:
    pass

print(json.dumps({"details": details, "missing": missing, "cuda_available": cuda_available, "mps_available": mps_available}))
`;
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([args.pythonBin, "-c", code], {
      env: {
        ...process.env,
        PYTHONPATH: [args.qwenDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      ok: false,
      detail: `Python runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
      missing: [],
    };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return {
      ok: false,
      detail: `Python runtime check failed: ${stderr.trim() || stdout.trim()}`,
      missing: [],
    };
  }
  try {
    const parsed = parseTrailingJsonObject(stdout) as {
      missing?: string[];
      cuda_available?: boolean;
      mps_available?: boolean;
    };
    const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
    return {
      ok: missing.length === 0,
      detail: missing.length > 0 ? `Missing Python modules: ${missing.join(", ")}` : "Python runtime dependencies import cleanly",
      missing,
      cudaAvailable: parsed.cuda_available,
      mpsAvailable: parsed.mps_available,
    };
  } catch {
    return {
      ok: false,
      detail: `Python runtime check returned non-JSON output: ${stdout.trim()}`,
      missing: [],
    };
  }
}

function addPreflightCheck(
  checks: Qwen3LoraPreflightCheck[],
  id: string,
  status: Qwen3LoraPreflightStatus,
  detail: string,
): void {
  checks.push({ id, status, detail });
}

export function normalizeQwen3LoraPrepareInput(raw: unknown, baseDir = process.cwd()): Qwen3LoraPrepareInput {
  if (!isObject(raw)) {
    throw new Error("qwen3-lora config must be an object");
  }
  return {
    train_metadata_csv: resolveConfigPath(requireString(raw, "train_metadata_csv"), baseDir) ?? "",
    eval_metadata_csv: resolveConfigPath(optionalString(raw, "eval_metadata_csv"), baseDir),
    clips_dir: resolveConfigPath(requireString(raw, "clips_dir"), baseDir) ?? "",
    ref_audio: resolveConfigPath(requireString(raw, "ref_audio"), baseDir) ?? "",
    output_dir: resolveConfigPath(requireString(raw, "output_dir"), baseDir) ?? "",
    speaker_name: optionalString(raw, "speaker_name"),
    copy_audio: raw.copy_audio === true,
    qwen_dir: resolveConfigPath(optionalString(raw, "qwen_dir"), baseDir),
    lora_tools_dir: resolveConfigPath(optionalString(raw, "lora_tools_dir"), baseDir),
    python_bin: optionalString(raw, "python_bin"),
    tokenizer_model_path: optionalString(raw, "tokenizer_model_path"),
    init_model_path: optionalString(raw, "init_model_path"),
    device: optionalString(raw, "device"),
    batch_size: optionalPositiveNumber(raw, "batch_size"),
    learning_rate: optionalString(raw, "learning_rate"),
    epochs: optionalPositiveNumber(raw, "epochs"),
    gradient_accumulation_steps: optionalPositiveNumber(raw, "gradient_accumulation_steps"),
    mixed_precision: optionalString(raw, "mixed_precision"),
    attention_implementation: optionalString(raw, "attention_implementation"),
    torch_dtype: optionalString(raw, "torch_dtype"),
    lora_rank: optionalPositiveNumber(raw, "lora_rank"),
    lora_alpha: optionalPositiveNumber(raw, "lora_alpha"),
    lora_dropout: optionalPositiveNumber(raw, "lora_dropout"),
    lora_scale: optionalPositiveNumber(raw, "lora_scale"),
  };
}

export async function prepareQwen3LoraDataset(input: Qwen3LoraPrepareInput): Promise<Qwen3LoraPrepareResult> {
  const outputDir = path.resolve(input.output_dir);
  const clipsDir = path.resolve(input.clips_dir);
  const refAudio = path.resolve(input.ref_audio);
  const trainMetadata = path.resolve(input.train_metadata_csv);
  const evalMetadata = input.eval_metadata_csv ? path.resolve(input.eval_metadata_csv) : undefined;
  const speakerName = normalizeSpeakerName(input.speaker_name);
  const qwenDir = input.qwen_dir ? path.resolve(input.qwen_dir) : path.join(outputDir, "tools", "Qwen3-TTS");
  const loraToolsDir = input.lora_tools_dir
    ? path.resolve(input.lora_tools_dir)
    : path.join(outputDir, "tools", "qwen3-tts-lora-finetuning");
  const pythonBin = input.python_bin || "python";
  const tokenizerModelPath = input.tokenizer_model_path || "Qwen/Qwen3-TTS-Tokenizer-12Hz";
  const initModelPath = input.init_model_path || "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
  const device = resolveTrainingDevice(input.device);
  const batchSize = input.batch_size ?? defaultBatchSizeForDevice(device);
  const learningRate = input.learning_rate || "2e-6";
  const epochs = input.epochs ?? 10;
  const gradAccumSteps = input.gradient_accumulation_steps ?? defaultGradAccumForDevice(device);
  const mixedPrecision = input.mixed_precision || defaultMixedPrecisionForDevice(device);
  const attentionImplementation = input.attention_implementation || defaultAttentionForDevice(device);
  const torchDtype = input.torch_dtype || defaultTorchDtypeForDevice(device);
  const loraRank = input.lora_rank ?? (isMpsDevice(device) ? 8 : 16);
  const loraAlpha = input.lora_alpha ?? loraRank * 2;
  const loraDropout = input.lora_dropout ?? 0.05;
  const loraScale = input.lora_scale ?? 0.3;

  await mkdir(outputDir, { recursive: true });
  if (!(await canRead(refAudio))) {
    throw new Error(`Reference audio not found: ${refAudio}`);
  }

  const trainRawJsonl = path.join(outputDir, "train_raw.jsonl");
  const evalRawJsonl = path.join(outputDir, "val_raw.jsonl");
  const trainJsonl = path.join(outputDir, "train_with_codes.jsonl");
  const evalJsonl = path.join(outputDir, "val_with_codes.jsonl");
  const audioOutDir = input.copy_audio ? path.join(outputDir, "audio") : undefined;
  const skipped: Qwen3LoraSkippedRow[] = [];
  const trainCount = await writeJsonlFromMetadata({
    metadataPath: trainMetadata,
    clipsDir,
    refAudio,
    outputPath: trainRawJsonl,
    outputAudioDir: audioOutDir,
    skipped,
  });
  const evalCount = evalMetadata
    ? await writeJsonlFromMetadata({
        metadataPath: evalMetadata,
        clipsDir,
        refAudio,
        outputPath: evalRawJsonl,
        outputAudioDir: audioOutDir,
        skipped,
      })
    : 0;
  if (!evalMetadata) {
    await writeFile(evalRawJsonl, "", "utf8");
  }

  const commands = buildCommands({
    qwenDir,
    loraToolsDir,
    pythonBin,
    tokenizerModelPath,
    initModelPath,
    device,
    trainRawJsonl,
    trainJsonl,
    evalRawJsonl,
    evalJsonl,
    outputDir,
    speakerName,
    batchSize,
    learningRate,
    epochs,
    gradAccumSteps,
    mixedPrecision,
    attentionImplementation,
    torchDtype,
    loraRank,
    loraAlpha,
    loraDropout,
  });
  const envPath = path.join(outputDir, "qwen3-lora.env");
  const prepareScriptPath = path.join(outputDir, "prepare-qwen3-data.sh");
  const trainScriptPath = path.join(outputDir, "train-qwen3-lora.sh");
  await writeFile(
    envPath,
    [
      envLine("QWEN_DIR", qwenDir),
      envLine("LORA_TOOLS_DIR", loraToolsDir),
      envLine("PYTHON_BIN", pythonBin),
      envLine("TOKENIZER_MODEL_PATH", tokenizerModelPath),
      envLine("INIT_MODEL_PATH", initModelPath),
      envLine("DEVICE", device),
      envLine("TRAIN_RAW_JSONL", trainRawJsonl),
      envLine("TRAIN_JSONL", trainJsonl),
      envLine("VAL_RAW_JSONL", evalRawJsonl),
      envLine("VAL_JSONL", evalJsonl),
      envLine("OUTPUT_DIR", path.join(outputDir, "adapter")),
      envLine("SPEAKER_NAME", speakerName),
      envLine("BATCH_SIZE", batchSize),
      envLine("LR", learningRate),
      envLine("EPOCHS", epochs),
      envLine("GRAD_ACCUM_STEPS", gradAccumSteps),
      envLine("MIXED_PRECISION", mixedPrecision),
      envLine("ATTN_IMPL", attentionImplementation),
      envLine("TORCH_DTYPE", torchDtype),
      envLine("LORA_RANK", loraRank),
      envLine("LORA_ALPHA", loraAlpha),
      envLine("LORA_DROPOUT", loraDropout),
      envLine("LORA_SCALE", loraScale),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    prepareScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/qwen3-lora.env"

"$PYTHON_BIN" "$QWEN_DIR/finetuning/prepare_data.py" \\
  --device "$DEVICE" \\
  --tokenizer_model_path "$TOKENIZER_MODEL_PATH" \\
  --input_jsonl "$TRAIN_RAW_JSONL" \\
  --output_jsonl "$TRAIN_JSONL"

if [[ -s "$VAL_RAW_JSONL" ]]; then
  "$PYTHON_BIN" "$QWEN_DIR/finetuning/prepare_data.py" \\
    --device "$DEVICE" \\
    --tokenizer_model_path "$TOKENIZER_MODEL_PATH" \\
    --input_jsonl "$VAL_RAW_JSONL" \\
    --output_jsonl "$VAL_JSONL"
fi
`,
    "utf8",
  );
  await writeFile(
    trainScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/qwen3-lora.env"

GRAD_ACCUM_STEPS="\${GRAD_ACCUM_STEPS:-${gradAccumSteps}}"
MIXED_PRECISION="\${MIXED_PRECISION:-${mixedPrecision}}"
ATTN_IMPL="\${ATTN_IMPL:-${attentionImplementation}}"
TORCH_DTYPE="\${TORCH_DTYPE:-${torchDtype}}"
LORA_RANK="\${LORA_RANK:-${loraRank}}"
LORA_ALPHA="\${LORA_ALPHA:-${loraAlpha}}"
LORA_DROPOUT="\${LORA_DROPOUT:-${loraDropout}}"
LORA_BIAS="\${LORA_BIAS:-none}"
LORA_TARGET_MODULES="\${LORA_TARGET_MODULES:-q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj}"
VAL_ARGS=()
if [[ -s "$VAL_JSONL" ]]; then
  VAL_ARGS=(--val_jsonl "$VAL_JSONL")
fi

"$PYTHON_BIN" "$QWEN_DIR/finetuning/sft_12hz_lora.py" \\
  --init_model_path "$INIT_MODEL_PATH" \\
  --output_model_path "$OUTPUT_DIR" \\
  --train_jsonl "$TRAIN_JSONL" \\
  --batch_size "$BATCH_SIZE" \\
  --lr "$LR" \\
  --num_epochs "$EPOCHS" \\
  --speaker_name "$SPEAKER_NAME" \\
  --device "$DEVICE" \\
  --gradient_accumulation_steps "$GRAD_ACCUM_STEPS" \\
  --mixed_precision "$MIXED_PRECISION" \\
  --attn_implementation "$ATTN_IMPL" \\
  --torch_dtype "$TORCH_DTYPE" \\
  --lora_rank "$LORA_RANK" \\
  --lora_alpha "$LORA_ALPHA" \\
  --lora_dropout "$LORA_DROPOUT" \\
  --lora_bias "$LORA_BIAS" \\
  --lora_target_modules "$LORA_TARGET_MODULES" \\
  "\${VAL_ARGS[@]}"
`,
    "utf8",
  );
  await chmod(prepareScriptPath, 0o755);
  await chmod(trainScriptPath, 0o755);

  return {
    output_dir: outputDir,
    train_raw_jsonl: trainRawJsonl,
    eval_raw_jsonl: evalRawJsonl,
    train_count: trainCount,
    eval_count: evalCount,
    skipped,
    env_path: envPath,
    prepare_script_path: prepareScriptPath,
    train_script_path: trainScriptPath,
    commands,
  };
}

export async function prepareQwen3LoraDatasetFromFile(configPath: string): Promise<Qwen3LoraPrepareResult> {
  const resolvedPath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  return prepareQwen3LoraDataset(normalizeQwen3LoraPrepareInput(raw, path.dirname(resolvedPath)));
}

export async function preflightQwen3LoraRun(input: Qwen3LoraPreflightInput): Promise<Qwen3LoraPreflightResult> {
  const runDir = path.resolve(input.run_dir);
  const envPath = path.join(runDir, "qwen3-lora.env");
  const checks: Qwen3LoraPreflightCheck[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!(await isFile(envPath))) {
    addPreflightCheck(checks, "config.env", "fail", `Missing qwen3-lora.env at ${envPath}`);
    blockers.push("Missing qwen3-lora.env");
    return {
      run_dir: runDir,
      ready: false,
      blockers,
      warnings,
      counts: {
        train_raw_rows: 0,
        eval_raw_rows: 0,
        invalid_jsonl_rows: 0,
        missing_audio_rows: 0,
        sample_rate_mismatch_files: 0,
        sample_rate_unknown_files: 0,
      },
      checks,
      commands: {
        prepare_script: path.join(runDir, "prepare-qwen3-data.sh"),
        train_script: path.join(runDir, "train-qwen3-lora.sh"),
      },
    };
  }

  addPreflightCheck(checks, "config.env", "pass", envPath);
  const env = parseEnvFile(await readFile(envPath, "utf8"));
  const qwenDir = env.QWEN_DIR || path.join(runDir, "tools", "Qwen3-TTS");
  const loraToolsDir = env.LORA_TOOLS_DIR || path.join(runDir, "tools", "qwen3-tts-lora-finetuning");
  const trainRawJsonl = env.TRAIN_RAW_JSONL || path.join(runDir, "train_raw.jsonl");
  const evalRawJsonl = env.VAL_RAW_JSONL || path.join(runDir, "val_raw.jsonl");
  const prepareScript = path.join(runDir, "prepare-qwen3-data.sh");
  const trainScript = path.join(runDir, "train-qwen3-lora.sh");
  const pythonBin = env.PYTHON_BIN || input.python_bin || process.env.PYTHON || "python";
  const device = resolveTrainingDevice(env.DEVICE);
  const requiredFiles = [
    {
      id: "qwen.prepare_data",
      path: path.join(qwenDir, "finetuning", "prepare_data.py"),
      blocker: "Missing Qwen3 prepare_data.py",
    },
    {
      id: "qwen.sft_lora",
      path: path.join(qwenDir, "finetuning", "sft_12hz_lora.py"),
      blocker: "Missing patched Qwen3 sft_12hz_lora.py",
    },
    {
      id: "lora.run_train",
      path: path.join(loraToolsDir, "scripts", "run_lora_train.sh"),
      blocker: "Missing Qwen3 LoRA training launcher",
    },
    {
      id: "script.prepare",
      path: prepareScript,
      blocker: "Missing generated prepare script",
    },
    {
      id: "script.train",
      path: trainScript,
      blocker: "Missing generated train script",
    },
  ];

  for (const required of requiredFiles) {
    if (await isFile(required.path)) {
      addPreflightCheck(checks, required.id, "pass", required.path);
    } else {
      addPreflightCheck(checks, required.id, "fail", `Missing file: ${required.path}`);
      blockers.push(required.blocker);
    }
  }

  const trainAudit = await auditJsonl(trainRawJsonl);
  const evalAudit = await auditJsonl(evalRawJsonl);
  const invalidJsonlRows = trainAudit.invalid + evalAudit.invalid;
  const missingAudioRows = trainAudit.missingAudio + evalAudit.missingAudio;

  if (trainAudit.count > 0 && trainAudit.invalid === 0) {
    addPreflightCheck(checks, "dataset.train_raw", "pass", `${trainAudit.count} train rows`);
  } else {
    addPreflightCheck(
      checks,
      "dataset.train_raw",
      "fail",
      `Train raw JSONL has ${trainAudit.count} rows and ${trainAudit.invalid} invalid rows`,
    );
    blockers.push("Train raw JSONL is missing or invalid");
  }

  if (evalAudit.count > 0 && evalAudit.invalid === 0) {
    addPreflightCheck(checks, "dataset.eval_raw", "pass", `${evalAudit.count} eval rows`);
  } else if (await exists(evalRawJsonl)) {
    addPreflightCheck(checks, "dataset.eval_raw", "warn", "Eval raw JSONL is empty");
    warnings.push("Eval raw JSONL is empty");
  } else {
    addPreflightCheck(checks, "dataset.eval_raw", "warn", `Eval raw JSONL missing: ${evalRawJsonl}`);
    warnings.push("Eval raw JSONL is missing");
  }

  if (invalidJsonlRows > 0) {
    blockers.push(`${invalidJsonlRows} invalid JSONL rows`);
  }
  if (missingAudioRows > 0) {
    addPreflightCheck(checks, "dataset.audio_paths", "fail", `${missingAudioRows} rows point at missing audio/ref_audio files`);
    blockers.push(`${missingAudioRows} dataset rows point at missing audio/ref_audio files`);
  } else {
    addPreflightCheck(checks, "dataset.audio_paths", "pass", "All audited audio and ref_audio paths are readable");
  }

  const sampleRates = await auditSampleRates([...new Set([...trainAudit.audioPaths, ...evalAudit.audioPaths])], 24000);
  if (sampleRates.mismatch > 0) {
    addPreflightCheck(
      checks,
      "dataset.sample_rate",
      "fail",
      `${sampleRates.mismatch} audio/ref_audio files are not 24000 Hz`,
    );
    blockers.push(`${sampleRates.mismatch} audio/ref_audio files must be resampled to 24000 Hz`);
  } else if (sampleRates.unknown > 0) {
    addPreflightCheck(
      checks,
      "dataset.sample_rate",
      "fail",
      `${sampleRates.unknown} audio/ref_audio files could not be inspected by ffprobe`,
    );
    blockers.push(`${sampleRates.unknown} audio/ref_audio files could not be inspected by ffprobe`);
  } else if (sampleRates.checked > 0) {
    addPreflightCheck(checks, "dataset.sample_rate", "pass", `All ${sampleRates.checked} audio/ref_audio files are 24000 Hz`);
  } else {
    addPreflightCheck(checks, "dataset.sample_rate", "warn", "No audio sample rates were inspected");
    warnings.push("No audio sample rates were inspected");
  }

  const sftLoraPath = path.join(qwenDir, "finetuning", "sft_12hz_lora.py");
  const sftLoraSource = (await isFile(sftLoraPath)) ? await readFile(sftLoraPath, "utf8") : "";
  const modelingPath = path.join(qwenDir, "qwen_tts", "core", "models", "modeling_qwen3_tts.py");
  const modelingSource = (await isFile(modelingPath)) ? await readFile(modelingPath, "utf8") : "";
  const hasUnshiftedTalkerLoss =
    /model\.talker\([\s\S]*inputs_embeds\s*=\s*input_embeddings\s*,[\s\S]*attention_mask\s*=\s*attention_mask\s*,[\s\S]*labels\s*=\s*codec_0_labels/.test(
      sftLoraSource,
    ) || /labels\s*=\s*codec_0_labels/.test(sftLoraSource);
  const hasShiftedHiddenStates = /hidden_states\s*=\s*outputs\.hidden_states\[0\]\[-1\]\s*\[:,\s*:-1\s*,/.test(
    sftLoraSource,
  );
  const hasShiftedCodecMask = /talker_hidden_states\s*=\s*hidden_states\s*\[\s*codec_mask\[:,\s*1:\]\s*\]/.test(
    sftLoraSource,
  );
  const hasLabelShiftPatch = hasUnshiftedTalkerLoss && hasShiftedHiddenStates && hasShiftedCodecMask;
  const hasModelingShiftLabelsPatch =
    /loss_function\(\s*logits\s*=\s*logits\s*,\s*labels\s*=\s*None\s*,\s*shift_labels\s*=\s*labels\.contiguous\(\)/.test(
      modelingSource,
    );
  const hasTextProjectionPatch =
    /model\.talker\.text_projection\s*\(/.test(sftLoraSource) &&
    /input_text_embedding\.shape\s*==\s*input_codec_embedding\.shape/.test(sftLoraSource);

  if (hasLabelShiftPatch) {
    addPreflightCheck(
      checks,
      "qwen.sft_lora_label_shift_patch",
      "pass",
      "sft_12hz_lora.py passes unshifted tensors and masks hidden states after the internal CE shift",
    );
  } else {
    addPreflightCheck(
      checks,
      "qwen.sft_lora_label_shift_patch",
      "fail",
      "sft_12hz_lora.py does not show the upstream label-shift fix; apply the local trainer patch",
    );
    blockers.push("Qwen3 LoRA training script is missing the label-shift fix");
  }

  if (hasModelingShiftLabelsPatch) {
    addPreflightCheck(
      checks,
      "qwen.modeling_label_shift_patch",
      "pass",
      "modeling_qwen3_tts.py routes finetune labels through shift_labels for single internal CE shift",
    );
  } else {
    addPreflightCheck(
      checks,
      "qwen.modeling_label_shift_patch",
      "fail",
      "modeling_qwen3_tts.py does not show PR #278 shift_labels loss routing",
    );
    blockers.push("Qwen3 model code is missing the label-shift loss fix");
  }

  if (hasTextProjectionPatch) {
    addPreflightCheck(
      checks,
      "qwen.sft_lora_text_projection_patch",
      "pass",
      "sft_12hz_lora.py projects text embeddings before masking and asserts matching embedding dims",
    );
  } else {
    addPreflightCheck(
      checks,
      "qwen.sft_lora_text_projection_patch",
      "fail",
      "sft_12hz_lora.py does not project text embeddings with a dimension assertion before masking",
    );
    blockers.push("Qwen3 LoRA training script is missing the text_projection fix");
  }

  if (isMpsDevice(device)) {
    const hasTorchDtypeArg = sftLoraSource.includes("--torch_dtype");
    const hasDeviceArg = sftLoraSource.includes("--device");
    const avoidsCudaFlashDefault = sftLoraSource.includes("attn_implementation") && !sftLoraSource.includes('default="flash_attention_2"');
    if (hasTorchDtypeArg && hasDeviceArg) {
      addPreflightCheck(checks, "qwen.sft_lora_mps_patch", "pass", "sft_12hz_lora.py accepts --device and --torch_dtype for MPS/CPU training");
    } else {
      addPreflightCheck(
        checks,
        "qwen.sft_lora_mps_patch",
        "fail",
        "sft_12hz_lora.py does not accept --device and --torch_dtype; apply the local MPS training patch first",
      );
      blockers.push("Qwen3 LoRA training script is not patched for MPS dtype selection");
    }
    if (avoidsCudaFlashDefault) {
      addPreflightCheck(checks, "qwen.sft_lora_attention_patch", "pass", "sft_12hz_lora.py no longer defaults to FlashAttention");
    } else {
      addPreflightCheck(
        checks,
        "qwen.sft_lora_attention_patch",
        "warn",
        "sft_12hz_lora.py still defaults to FlashAttention unless ATTN_IMPL overrides it",
      );
      warnings.push("MPS runs must use ATTN_IMPL=eager or sdpa; FlashAttention is CUDA-only");
    }
  }

  const runtime = await runPythonRuntimeCheck({ pythonBin, qwenDir, device });
  if (runtime.ok) {
    addPreflightCheck(checks, "runtime.python", "pass", runtime.detail);
  } else {
    addPreflightCheck(checks, "runtime.python", "fail", runtime.detail);
    blockers.push("Python runtime is not ready for Qwen3 LoRA training");
  }

  if (isCudaDevice(device)) {
    if (runtime.cudaAvailable === true) {
      addPreflightCheck(checks, "runtime.cuda", "pass", `CUDA is available for ${device}`);
    } else {
      addPreflightCheck(checks, "runtime.cuda", "fail", `Configured device is ${device}, but CUDA is not available`);
      blockers.push("CUDA is required for the configured Qwen3 LoRA training device");
    }
  } else if (isMpsDevice(device)) {
    if (runtime.mpsAvailable === true) {
      addPreflightCheck(checks, "runtime.mps", "pass", "MPS is available for Apple Silicon training probes");
      warnings.push("MPS Qwen3 LoRA training is an experimental local path; expect slow first probes and possible unsupported ops");
    } else {
      addPreflightCheck(checks, "runtime.mps", "fail", "Configured device is mps, but PyTorch MPS is not available");
      blockers.push("PyTorch MPS is required for the configured Qwen3 LoRA training device");
    }
  } else {
    addPreflightCheck(checks, "runtime.device", "warn", `Configured device is ${device}; Qwen3 LoRA tooling is CUDA-first`);
    warnings.push(`Configured device is ${device}; Qwen3 LoRA tooling is CUDA-first`);
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  return {
    run_dir: runDir,
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    counts: {
      train_raw_rows: trainAudit.count,
      eval_raw_rows: evalAudit.count,
      invalid_jsonl_rows: invalidJsonlRows,
      missing_audio_rows: missingAudioRows,
      sample_rate_mismatch_files: sampleRates.mismatch,
      sample_rate_unknown_files: sampleRates.unknown,
    },
    checks,
    commands: {
      prepare_script: prepareScript,
      train_script: trainScript,
    },
  };
}
