import type { NarrationPacingConfig } from "../core/render-types.js";
import { planNarrationUtterances, type PlannedUtterance } from "./utterances.js";
import { splitForBreathing } from "./breathing.js";

export interface Piece {
  text: string;
  pauseAfterSeconds: number;
}

/** utterances-v1: the job planner, with its original pacing options. */
export function utterancesV1(text: string, config: NarrationPacingConfig = {}): Piece[] {
  return planNarrationUtterances(text, config).map(piece => ({ text: piece.text, pauseAfterSeconds: piece.pause_after_seconds }));
}

/** breathing-v1: the runner planner, with its original pad arguments. */
export function breathingV1(text: string, sentencePad: number, commaPad: number): Piece[] {
  return splitForBreathing(text, sentencePad, commaPad).map(piece => ({ text: piece.text, pauseAfterSeconds: piece.padAfterSeconds }));
}

export function toPlannedUtterances(pieces: Piece[]): PlannedUtterance[] {
  return pieces.map(piece => ({ text: piece.text, pause_after_seconds: piece.pauseAfterSeconds }));
}

export function toBreathingPieces(pieces: Piece[]): ReturnType<typeof splitForBreathing> {
  return pieces.map(piece => ({ text: piece.text, padAfterSeconds: piece.pauseAfterSeconds }));
}
