import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cutEnding, cutPieceEndings, firstWordOmitted, pitchRunaway, wordMismatches, type CutEndingResult, type WordCheckOptions, type RecognisedWord } from "./take-checks.js";

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

/** Decode any audio file to mono float samples at `rate`; throws on any decode failure. */
function decodeMono(file: string, rate: number): Float32Array {
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-ar", String(rate), "-ac", "1", "-f", "f32le", "pipe:1"], { maxBuffer: 256 * 1024 * 1024 });
  if (decoded.error || decoded.status !== 0 || !decoded.stdout.length) throw new Error(`audio decode failed (ffmpeg required): ${file}`);
  const samples = new Float32Array(decoded.stdout.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = decoded.stdout.readFloatLE(i * 4);
  return samples;
}

/** `pieces.json` as `--keep-pieces` writes it (`src/pipelines/local-tts/keep-pieces.ts`). */
export type KeptPieces = { totalSamples: number; pieces: { file: string; text: string; samples: number; durationSeconds: number;
  pauseAfterSeconds: number; offsetSeconds: number }[] };

export async function readKeptPieces(dir: string): Promise<KeptPieces> {
  const kept: unknown = JSON.parse(await readFile(path.join(dir, "pieces.json"), "utf8"));
  if (typeof kept !== "object" || kept === null || !("pieces" in kept) || !Array.isArray(kept.pieces) || !kept.pieces.length
    || !("totalSamples" in kept) || typeof kept.totalSamples !== "number") throw new Error(`not a kept-pieces directory: ${dir}`);
  return kept as KeptPieces;
}

export type CutTakeEndResult = {
  failed: boolean;
  reason: CutEndingResult["reason"];
  tailRelDb: number | null;
  /** Steepest 50 ms fall at the end of sound, dB per 10 ms (the fade rule's measure). */
  fadeDbPer10ms: number | null;
  audioEndSeconds: number;
  lastWordEndSeconds: number | null;
  note?: NonNullable<CutEndingResult["note"]>;
};

/**
 * Cut take end: the finished take decoded at 16 kHz (fricative endings keep their energy) and its recognised
 * words, judged by `cutEnding`. The runner's take loop and `check-take` both judge the take's last word here.
 */
export function cutTakeEnd(wav: string, words: readonly RecognisedWord[]): CutTakeEndResult {
  const cut = cutEnding(decodeMono(wav, 16000), 16000, words);
  return { failed: cut.failed, reason: cut.reason, tailRelDb: cut.tailRelDb, fadeDbPer10ms: cut.fadeDbPer10ms,
    audioEndSeconds: Math.round(cut.audioEndSeconds * 1000) / 1000, lastWordEndSeconds: cut.lastWordEndSeconds,
    ...(cut.note ? { note: cut.note } : {}) };
}

export type CutJoinsResult = {
  failed: boolean;
  piecesChecked: number;
  cuts: { piece: number; of: number; text: string; reason: NonNullable<CutEndingResult["reason"]>;
    tailRelDb: number | null; fadeDbPer10ms: number | null; endSeconds: number; lastWordEndSeconds: number | null }[];
};

/**
 * Cut joins on kept pieces: each piece's own audio as joined (16 kHz), its offset and pause from `pieces.json`,
 * and the take's recognised words. The runner's take loop and `check-take --pieces` both judge joins here.
 */
export function cutJoinsInKeptPieces(dir: string, kept: KeptPieces, words: readonly RecognisedWord[]): CutJoinsResult {
  const judged = cutPieceEndings(kept.pieces.map(p => ({ samples: decodeMono(path.join(dir, p.file), 16000),
    startSeconds: p.offsetSeconds, spanSeconds: p.durationSeconds + p.pauseAfterSeconds })), 16000, words);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const cuts = judged.flatMap(({ index, result }) => result.failed && result.reason ? [{ piece: index + 1,
    of: kept.pieces.length, text: kept.pieces[index]!.text, reason: result.reason, tailRelDb: result.tailRelDb,
    fadeDbPer10ms: result.fadeDbPer10ms, endSeconds: round(kept.pieces[index]!.offsetSeconds + result.audioEndSeconds),
    lastWordEndSeconds: result.lastWordEndSeconds === null ? null : round(kept.pieces[index]!.offsetSeconds + result.lastWordEndSeconds) }] : []);
  return { failed: cuts.length > 0, piecesChecked: judged.length, cuts };
}

export const JOINS_NOT_JUDGED = "joins not judged: no --pieces directory (the runner's --keep-pieces output); piece boundaries are never re-split from silence";

/** Kept pieces must add up to the take they claim to be: this many seconds apart at most. */
const PIECES_MATCH_SECONDS = 0.02;

export async function checkTake(wav: string, sentFile: string, wordsFile: string, voice: string, ceilingHz: number,
  wordOptions: WordCheckOptions = {}, piecesDir?: string) {
  if (!voice.trim() || !Number.isFinite(ceilingHz) || ceilingHz <= 0) throw new Error("voice and positive pitch ceiling required");
  const sent = await readFile(sentFile, "utf8");
  const words = parseWords(JSON.parse(await readFile(wordsFile, "utf8")));
  const firstWord = firstWordOmitted(sent, words);
  const wordMatch = wordMismatches(sent, words, wordOptions);
  const samples = decodeMono(wav, 8000);
  const pitch = pitchRunaway(samples, 8000, ceilingHz);
  const takeEnd = cutTakeEnd(wav, words);
  const cutJoins: CutJoinsResult & { judged: boolean; note?: string } = await (async () => {
    if (piecesDir === undefined) return { judged: false, failed: false, piecesChecked: 0, cuts: [], note: JOINS_NOT_JUDGED };
    const kept = await readKeptPieces(piecesDir);
    const piecesSeconds = kept.totalSamples / (kept.pieces[0]!.samples / kept.pieces[0]!.durationSeconds);
    if (Math.abs(piecesSeconds - samples.length / 8000) > PIECES_MATCH_SECONDS)
      throw new Error(`kept pieces do not match this take: ${piecesSeconds.toFixed(3)} s of pieces, ${(samples.length / 8000).toFixed(3)} s of take`);
    return { judged: true, ...cutJoinsInKeptPieces(piecesDir, kept, words) };
  })();
  return { pass: wordMatch.pass && !firstWord.omitted && !pitch.failed && pitch.worstMedianHz !== null
    && !takeEnd.failed && !cutJoins.failed, voice, firstWord, wordMatch, pitch, cutEnding: takeEnd, cutJoins };
}
