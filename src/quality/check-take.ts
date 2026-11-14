import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { firstWordOmitted, pitchRunaway, type RecognisedWord } from "./take-checks.js";

function parseWords(value: unknown): RecognisedWord[] {
  if (!Array.isArray(value)) throw new Error("words must be an array");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("word" in item) || !("start" in item) || !("end" in item)
      || typeof item.word !== "string" || typeof item.start !== "number" || typeof item.end !== "number"
      || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) {
      throw new Error("invalid recognised word");
    }
    return { word: item.word, start: item.start, end: item.end };
  });
}

export async function checkTake(wav: string, sentFile: string, wordsFile: string, voice: string, ceilingHz: number) {
  if (!voice.trim() || !Number.isFinite(ceilingHz) || ceilingHz <= 0) throw new Error("voice and positive pitch ceiling required");
  const sent = await readFile(sentFile, "utf8");
  const words = parseWords(JSON.parse(await readFile(wordsFile, "utf8")));
  const firstWord = firstWordOmitted(sent, words);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", wav, "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"], { maxBuffer: 256 * 1024 * 1024 });
  if (decoded.error || decoded.status !== 0 || !decoded.stdout.length) throw new Error("audio decode failed (ffmpeg required)");
  const bytes = decoded.stdout;
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
  const pitch = pitchRunaway(samples, 8000, ceilingHz);
  return { pass: !firstWord.omitted && !pitch.failed && pitch.worstMedianHz !== null, voice, firstWord, pitch };
}
