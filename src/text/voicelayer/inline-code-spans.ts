export function inlineCodeSpanEnds(input: string, includeUnpaired = false): Map<number, number> {
  // Fences divide inline parsing regions: a stray tick before a block cannot
  // pair with a tick in or after that block. Keep offsets in the original text.
  const fences = Array.from(input.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*$/gm));
  const fenceOffsets = new Set(fences.map(f => f.index! + f[0].indexOf(f[1])));
  const boundaries: { start: number; end: number }[] = [];
  let open: RegExpMatchArray | undefined;
  for (const fence of fences) {
    if (!open) { open = fence; continue; }
    if (fence[1][0] === open[1][0] && fence[1].length >= open[1].length && !fence[0].slice(fence[0].indexOf(fence[1]) + fence[1].length).trim()) {
      boundaries.push({ start: open.index!, end: fence.index! + fence[0].length }); open = undefined;
    }
  }
  let region = boundaries.length - 1;
  const runs = Array.from(input.matchAll(/`+/g));
  const nextRunByLength = new Map<number, number>();
  const closingRuns = new Map<number, number>();
  const openingOffsets = new Map<number, number>();
  const fenced = new Set<number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    while (region >= 0 && run.index < boundaries[region].end) {
      nextRunByLength.clear();
      if (run.index >= boundaries[region].start) break;
      region--;
    }
    if (region >= 0 && run.index >= boundaries[region].start && run.index < boundaries[region].end) { fenced.add(i); continue; }
    let backslashes = 0;
    for (let at = run.index - 1; at >= 0 && input[at] === "\\"; at--) backslashes++;
    const escaped = backslashes % 2;
    // A fully escaped tick is prose; a longer run can still open after it.
    if (run[0].length > escaped) openingOffsets.set(i, run.index + escaped);
    const closing = nextRunByLength.get(run[0].length - escaped);
    if (closing !== undefined) {
      closingRuns.set(i, closing);
    }
    nextRunByLength.set(run[0].length, i);
  }
  const ends = new Map<number, number>();
  for (let i = 0; i < runs.length; i++) {
    const closing = closingRuns.get(i), start = openingOffsets.get(i);
    if (closing === undefined || start === undefined) {
      if (includeUnpaired && start !== undefined && !fenced.has(i) && !fenceOffsets.has(runs[i].index)) {
        const at = start;
        // A stray delimiter owns only its attached token, never later prose.
        // A separated tick therefore becomes an omission with its own anchor.
        const tokenEnd = at + input.slice(at).match(/^`+[^\s`]*/u)![0].length;
        ends.set(at, tokenEnd);
      }
      continue;
    }
    ends.set(start, runs[closing].index + runs[closing][0].length);
    i = closing;
  }
  return ends;
}
