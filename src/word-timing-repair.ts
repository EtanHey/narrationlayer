import type { WordTiming } from "./schema.js";

export interface WordTimingRepairResult {
  words: WordTiming[];
  repaired: boolean;
  reason?: "word_mismatch" | "suspicious_timing";
  estimated?: boolean;
}

function scriptWords(script: string): string[] {
  return String(script || "")
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w.?!,;:]+$/g, ""))
    .filter(Boolean);
}

function comparable(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(3));
}

function averageConfidence(items: WordTiming[]): number | undefined {
  const confidences = items
    .map((item) => item.confidence)
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (confidences.length === 0) {
    return undefined;
  }
  return Number((confidences.reduce((sum, item) => sum + item, 0) / confidences.length).toFixed(3));
}

function wordsMatchScript(scriptTokens: string[], timings: WordTiming[]): boolean {
  if (scriptTokens.length !== timings.length) {
    return false;
  }
  return scriptTokens.every((word, index) => comparable(word) === comparable(timings[index].word));
}

function hasSuspiciousTiming(timings: WordTiming[], durationSeconds: number): boolean {
  if (!timings.length) {
    return true;
  }
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : timings.at(-1)?.end ?? 0;
  const maxReasonableWordDuration = Math.max(0.9, safeDuration / Math.max(timings.length, 1) * 2.4);
  for (let index = 0; index < timings.length; index += 1) {
    const timing = timings[index];
    const wordDuration = timing.end - timing.start;
    if (wordDuration < 0.05 || wordDuration > maxReasonableWordDuration) {
      return true;
    }
    if (index > 0 && timing.start < timings[index - 1].end - 0.01) {
      return true;
    }
  }
  const last = timings[timings.length - 1];
  return safeDuration > 0 && last.end < safeDuration * 0.85;
}

type AlignmentStep =
  | {
      kind: "match";
      scriptStart: number;
      scriptCount: number;
      timingStart: number;
      timingCount: number;
    }
  | {
      kind: "missing_script";
      scriptStart: number;
      scriptCount: 1;
      timingStart: number;
      timingCount: 0;
    }
  | {
      kind: "extra_timing";
      scriptStart: number;
      scriptCount: 0;
      timingStart: number;
      timingCount: 1;
    };

interface AlignmentCell {
  cost: number;
  prevI: number;
  prevJ: number;
  step: AlignmentStep | null;
}

interface AlignmentAssignment {
  start: number;
  end: number;
  confidence?: number;
}

function editDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const replace = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, replace);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[b.length];
}

function blockMatchCost(scriptNorm: string, timingNorm: string, scriptCount: number, timingCount: number): number | null {
  if (!scriptNorm || !timingNorm) {
    return null;
  }
  if (scriptNorm === timingNorm) {
    return 0.01 * (scriptCount + timingCount - 2);
  }

  // A small fuzzy allowance handles common Whisper spelling variants while
  // keeping deletions/substitutions more expensive than exact split/merge matches.
  const maxLen = Math.max(scriptNorm.length, timingNorm.length);
  if (maxLen >= 5) {
    const distance = editDistance(scriptNorm, timingNorm);
    if (distance <= 1 || distance / maxLen <= 0.18) {
      return 0.25 + distance / maxLen + 0.01 * (scriptCount + timingCount - 2);
    }
  }
  return null;
}

function maybeUpdate(cells: AlignmentCell[][], i: number, j: number, nextI: number, nextJ: number, cost: number, step: AlignmentStep) {
  const nextCost = cells[i][j].cost + cost;
  if (nextCost < cells[nextI][nextJ].cost) {
    cells[nextI][nextJ] = {
      cost: nextCost,
      prevI: i,
      prevJ: j,
      step,
    };
  }
}

function alignmentSteps(scriptTokens: string[], timings: WordTiming[]): AlignmentStep[] {
  const scriptNorms = scriptTokens.map(comparable);
  const timingNorms = timings.map((timing) => comparable(timing.word));
  const scriptCount = scriptTokens.length;
  const timingCount = timings.length;
  const cells: AlignmentCell[][] = Array.from({ length: scriptCount + 1 }, () =>
    Array.from({ length: timingCount + 1 }, () => ({
      cost: Number.POSITIVE_INFINITY,
      prevI: -1,
      prevJ: -1,
      step: null,
    })),
  );
  cells[0][0] = { cost: 0, prevI: -1, prevJ: -1, step: null };

  const maxScriptBlock = 4;
  const maxTimingBlock = 4;
  for (let i = 0; i <= scriptCount; i += 1) {
    for (let j = 0; j <= timingCount; j += 1) {
      if (!Number.isFinite(cells[i][j].cost)) {
        continue;
      }
      if (i < scriptCount) {
        maybeUpdate(cells, i, j, i + 1, j, 1, {
          kind: "missing_script",
          scriptStart: i,
          scriptCount: 1,
          timingStart: j,
          timingCount: 0,
        });
      }
      if (j < timingCount) {
        maybeUpdate(cells, i, j, i, j + 1, 1.05, {
          kind: "extra_timing",
          scriptStart: i,
          scriptCount: 0,
          timingStart: j,
          timingCount: 1,
        });
      }
      for (let a = 1; a <= maxScriptBlock && i + a <= scriptCount; a += 1) {
        const scriptNorm = scriptNorms.slice(i, i + a).join("");
        for (let b = 1; b <= maxTimingBlock && j + b <= timingCount; b += 1) {
          const timingNorm = timingNorms.slice(j, j + b).join("");
          const cost = blockMatchCost(scriptNorm, timingNorm, a, b);
          if (cost === null) {
            continue;
          }
          maybeUpdate(cells, i, j, i + a, j + b, cost, {
            kind: "match",
            scriptStart: i,
            scriptCount: a,
            timingStart: j,
            timingCount: b,
          });
        }
      }
    }
  }

  const steps: AlignmentStep[] = [];
  let i = scriptCount;
  let j = timingCount;
  while (i > 0 || j > 0) {
    const cell = cells[i][j];
    if (!cell.step) {
      break;
    }
    steps.push(cell.step);
    i = cell.prevI;
    j = cell.prevJ;
  }
  return steps.reverse();
}

function assignMatchedTimings(
  assignments: Array<AlignmentAssignment | undefined>,
  scriptTokens: string[],
  timings: WordTiming[],
  step: Extract<AlignmentStep, { kind: "match" }>,
) {
  const matchedTimings = timings.slice(step.timingStart, step.timingStart + step.timingCount);
  if (step.scriptCount === 1) {
    assignments[step.scriptStart] = {
      start: matchedTimings[0].start,
      end: matchedTimings[matchedTimings.length - 1].end,
      confidence: averageConfidence(matchedTimings),
    };
    return;
  }

  if (step.scriptCount === step.timingCount) {
    for (let offset = 0; offset < step.scriptCount; offset += 1) {
      const timing = matchedTimings[offset];
      assignments[step.scriptStart + offset] = {
        start: timing.start,
        end: timing.end,
        confidence: timing.confidence,
      };
    }
    return;
  }

  const start = matchedTimings[0].start;
  const end = matchedTimings[matchedTimings.length - 1].end;
  const span = Math.max(0, end - start);
  const weights = scriptTokens
    .slice(step.scriptStart, step.scriptStart + step.scriptCount)
    .map((word) => Math.max(1, comparable(word).length));
  const totalWeight = weights.reduce((sum, item) => sum + item, 0);
  let cursor = start;
  for (let offset = 0; offset < step.scriptCount; offset += 1) {
    const isLast = offset === step.scriptCount - 1;
    const next = isLast ? end : cursor + span * (weights[offset] / totalWeight);
    assignments[step.scriptStart + offset] = {
      start: cursor,
      end: next,
      confidence: averageConfidence(matchedTimings),
    };
    cursor = next;
  }
}

function fillMissingAssignments(assignments: Array<AlignmentAssignment | undefined>, durationSeconds: number) {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined;
  let index = 0;
  while (index < assignments.length) {
    if (assignments[index]) {
      index += 1;
      continue;
    }
    const startIndex = index;
    while (index < assignments.length && !assignments[index]) {
      index += 1;
    }
    const endIndex = index - 1;
    const previous = startIndex > 0 ? assignments[startIndex - 1] : undefined;
    const next = index < assignments.length ? assignments[index] : undefined;
    const gapStart = previous?.end ?? 0;
    const gapEnd = next?.start ?? safeDuration ?? gapStart;
    const span = Math.max(0, gapEnd - gapStart);
    const count = endIndex - startIndex + 1;
    for (let offset = 0; offset < count; offset += 1) {
      const itemStart = gapStart + span * (offset / count);
      const itemEnd = offset === count - 1 ? gapEnd : gapStart + span * ((offset + 1) / count);
      assignments[startIndex + offset] = { start: itemStart, end: itemEnd };
    }
  }
}

function alignWordTimingsToScript(
  scriptTokens: string[],
  timings: WordTiming[],
  durationSeconds: number,
): { words: WordTiming[]; matchedScriptWords: number } {
  const assignments: Array<AlignmentAssignment | undefined> = new Array(scriptTokens.length);
  const steps = alignmentSteps(scriptTokens, timings);
  let matchedScriptWords = 0;
  for (const step of steps) {
    if (step.kind === "match") {
      matchedScriptWords += step.scriptCount;
      assignMatchedTimings(assignments, scriptTokens, timings, step);
    }
  }
  fillMissingAssignments(assignments, durationSeconds);

  let previousStart = 0;
  const words = scriptTokens.map((word, index) => {
    const assignment = assignments[index] ?? { start: previousStart, end: previousStart };
    const start = Math.max(previousStart, assignment.start);
    const end = Math.max(start, assignment.end);
    previousStart = start;
    const confidence = assignment.confidence;
    return {
      index,
      word,
      start: roundSeconds(start),
      end: roundSeconds(end),
      ...(confidence === undefined ? {} : { confidence }),
    };
  });
  return { words, matchedScriptWords };
}

export function normalizeWordTimingsForScript(
  script: string,
  timings: WordTiming[],
  durationSeconds: number,
): WordTimingRepairResult {
  const expectedWords = scriptWords(script);
  if (!expectedWords.length) {
    return { words: timings, repaired: false };
  }

  if (!wordsMatchScript(expectedWords, timings)) {
    const alignment = alignWordTimingsToScript(expectedWords, timings, durationSeconds);
    return {
      words: alignment.words,
      repaired: true,
      reason: "word_mismatch",
      estimated: alignment.matchedScriptWords === 0,
    };
  }

  if (hasSuspiciousTiming(timings, durationSeconds)) {
    return {
      words: timings.map((timing, index) => ({ ...timing, word: expectedWords[index], index })),
      repaired: false,
      reason: "suspicious_timing",
    };
  }

  return {
    words: timings.map((timing, index) => ({ ...timing, index })),
    repaired: false,
  };
}
