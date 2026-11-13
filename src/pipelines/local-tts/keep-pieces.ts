import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunnerFailure } from "./failure.js";

/** One piece's audio as it went into the join, and the silence (if any) joined after it. */
export interface JoinedPiece {
  text: string;
  audioPath: string;
  pauseAfterPath?: string;
}

/** `--keep-pieces` refuses a directory that already holds files; it never deletes in it. */
export async function assertKeepPiecesDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw new RunnerFailure(`--keep-pieces directory is not readable: ${dir} (${code ?? String(error)})`);
  }
  if (entries.length > 0) throw new RunnerFailure(`--keep-pieces directory must not exist or must be empty: ${dir}`);
}

/** Sample count per channel and sample rate, read from the WAV's own fmt and data chunks. */
async function wavSamples(file: string): Promise<{ samples: number; sampleRate: number }> {
  const bytes = await readFile(file);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
    throw new RunnerFailure(`kept piece is not a RIFF/WAVE file: ${file}`);
  let channels = 0, sampleRate = 0, bits = 0, dataBytes: number | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    }
    if (id === "data") dataBytes = Math.min(size, bytes.length - at - 8);
    at += 8 + size + (size % 2);
  }
  if (!channels || !bits || dataBytes === undefined) throw new RunnerFailure(`kept piece has no fmt or data chunk: ${file}`);
  return { samples: dataBytes / (channels * (bits / 8)), sampleRate };
}

/**
 * Copy each joined piece into `dir` as `piece-<NNN>.wav` and write `pieces.json`: index,
 * spoken text, samples and duration, the pause after it and its offset in the joined file.
 */
export async function keepPieces(dir: string, pieces: JoinedPiece[]): Promise<number> {
  await assertKeepPiecesDir(dir);
  await mkdir(dir, { recursive: true });
  const rows = [];
  let offsetSamples = 0;
  for (const [index, piece] of pieces.entries()) {
    const file = `piece-${String(index).padStart(3, "0")}.wav`;
    await copyFile(piece.audioPath, path.join(dir, file));
    const { samples, sampleRate } = await wavSamples(piece.audioPath);
    const pause = piece.pauseAfterPath ? (await wavSamples(piece.pauseAfterPath)).samples : 0;
    rows.push({
      index,
      file,
      text: piece.text,
      samples,
      durationSeconds: samples / sampleRate,
      pauseAfterSamples: pause,
      pauseAfterSeconds: pause / sampleRate,
      offsetSamples,
      offsetSeconds: offsetSamples / sampleRate,
    });
    offsetSamples += samples + pause;
  }
  await writeFile(path.join(dir, "pieces.json"), `${JSON.stringify({ version: 1, totalSamples: offsetSamples, pieces: rows }, null, 2)}\n`, "utf8");
  return rows.length;
}
