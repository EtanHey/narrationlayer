import { inlineCodeSpanEnds } from "./inline-code-spans";

/** Convert markdown to speech text without fetching links or evaluating code. */
export function markdownToSpeech(markdown: string): string {
  return markdownSpeechLines(markdown).map(line => line.text).filter(Boolean).join(" ");
}

/** Internal projection seam: offsets refer to the unmodified UTF-16 input. */
export interface MarkdownSpeechLine {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  kind?: "code";
}

export function markdownSpeechLines(markdown: string): MarkdownSpeechLine[] {
  const code = [...inlineCodeSpanEnds(markdown, true)];
  const lines = speechLinesFromFences(markdown);
  let span = 0;
  const output = lines.map(line => {
    const marker = line.text.match(/^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\](?!\()/)?.[0];
    const at = line.sourceStart + (marker?.indexOf("[") ?? 0);
    while (span < code.length && code[span][1] <= line.sourceStart) span++;
    const literalTask = !!marker && code[span]?.[0] <= at && at < code[span]?.[1];
    const completed = !!marker && !marker.endsWith("[ ]") && !literalTask;
    const literals: {token: string; text: string}[] = [];
    let protectedText = "", cursor = 0;
    for (let i = span; i < code.length && code[i][0] < line.sourceEnd; i++) {
      const [start, end] = code[i];
      const raw = markdown.slice(start, end);
      // Keep delimiters only for checkbox spans or code the prose normalisers
      // would rewrite. The lead approved visible ticks on these literal spans;
      // plain `foo` displays without ticks and the speakable pass removes all
      // retained ticks before sending text to either TTS engine.
      const ticks = raw.match(/^`+/)![0];
      const paired = raw.length >= ticks.length * 2 && raw.match(/`+$/)?.[0] === ticks;
      const keep = !paired || /\[[ xX]\]|[$€£¥₪][ \t]*-?\d|\b[vV^~]?\d+(?:\.\d+|\/[A-Za-z])|(?:[\w-]+|\.[A-Za-z]+)\.[A-Za-z]|-\d+\b/.test(raw);
      const left = Math.max(start, line.sourceStart) - line.sourceStart;
      const right = Math.min(end, line.sourceEnd) - line.sourceStart;
      let token = `\uE000${literals.length}\uE001`;
      while (markdown.includes(token)) token = "\uE000" + token;
      const literal = line.text.slice(left, right);
      // Preserve exactly the captured delimiter; unmatched ticks protect only
      // their attached token in the speakable pass, with no invented closer.
      literals.push({token, text: keep ? literal : literal.replace(/`+/g, "")});
      protectedText += line.text.slice(cursor, left) + token;
      cursor = right;
    }
    protectedText += line.text.slice(cursor);
    let text = speechLineText(protectedText, { literalTask });
    // Tokens are local to this line and cannot collide with captured text.
    for (const literal of literals) text = text.split(literal.token).join(literal.text);
    return { ...line, text, completed, taskBody: marker ? line.text.slice(marker.length) : "" };
  });
  // Delay completion until the final indented continuation of a checked item.
  for (let i = 0; i < output.length; i++) {
    if (!output[i].completed) continue;
    let end = i;
    const quoteDepth = (text: string) => text.match(/^[ \t]*(?:>[ \t]*)*/)?.[0].match(/>/g)?.length ?? 0;
    const depth = quoteDepth(lines[i].text);
    while (end + 1 < output.length && quoteDepth(lines[end + 1].text) === depth &&
      (depth > 0 || /^[ \t]+\S/.test(lines[end + 1].text)) &&
      !!output[end + 1].text &&
      !/^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+/.test(lines[end + 1].text) &&
      !markdown.slice(output[end].sourceEnd, output[end + 1].sourceStart).replace(/\r?\n/, "")) end++;
    const body = [output[i].taskBody, ...lines.slice(i + 1, end + 1).map(line => line.text)].join(" ");
    if (!/[\p{L}\p{N}\p{S}]/u.test(body)) continue;
    if (end > i) output[i].text = output[i].text.replace(/\.$/, "");
    output[end].text = output[end].text.replace(/[.!?,;:]+$/, "") + ", done.";
  }
  return output.map(({ completed, taskBody, ...line }) => line);
}

function speechLineText(raw: string, { literalTask = false } = {}): string {
  if (/^\s*\[[^\]]+\]:\s*\S+/.test(raw) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw) || /^\s*=+\s*$/.test(raw)) return "";
  let line = raw.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").replace(/^[ \t]*(?:>[ \t]*)+/, "");
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return "";
  const list = /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
  const listMarker = literalTask ? /^\s*(?:([-+*])|(\d+)([.)]))\s+/ : /^\s*(?:([-+*])|(\d+)([.)]))\s+(?:\[[ xX]\]\s*)?/;
  line = line.replace(listMarker, (_match, _bullet, digits, punctuation) => digits ? `${digits}${punctuation} ` : "");
  line = stripInlineLinkTargets(line)
    .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, "link")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, (url) => `link${url.match(/[.,!?;:]+$/)?.[0] ?? ""}`)
    .replace(/`+/g, "").replace(/\*\*/g, "").replace(/\*([^*]+)\*/g, "$1")
    // Prefer identifiers for ambiguous __word__; strip underscores only at boundaries.
    .replace(/(?<![\p{L}\p{N}_])__([^_\n]*\s[^_\n]*)__(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1");
  if (line.includes("|")) line = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
  line = line.trim();
  if (line && (list || raw.includes("|")) && !/[.!?…。！？]$/.test(line)) line += ".";
  return line.replace(/\s+/g, " ").trim();
}

function stripInlineLinkTargets(line: string): string {
  const start = /!?\[([^\[\]\n]*)\]\(/g;
  const pieces: string[] = [];
  let copiedThrough = 0;
  for (let match = start.exec(line); match; match = start.exec(line)) {
    let depth = 1;
    let end = start.lastIndex;
    for (; end < line.length && depth > 0; end++) {
      if (line[end] === "\\") { end++; continue; }
      if (line[end] === "(") depth++;
      if (line[end] === ")") depth--;
    }
    if (depth > 0) break;
    pieces.push(line.slice(copiedThrough, match.index), match[1]);
    copiedThrough = end;
    start.lastIndex = end;
  }
  pieces.push(line.slice(copiedThrough));
  return pieces.join("");
}

/** Recognize syntax only; unknown lines in a partial selection are retained as prose. */
function looksLikeCode(line: string): boolean {
  const text = line.trim();
  // Sentence evidence wins, even with a keyword, indentation or an equals sign.
  if (/\p{L}/u.test(text) && /\s/u.test(text) && /[.!?]$/u.test(text)) return false;
  const codePunctuation = /[;{}()[\]=:+*/\\<>"'`,]/u;
  const plainWords = text.split(/\s+/u).filter((word) => /^\p{L}+$/u.test(word));
  if (plainWords.length >= 4 && !codePunctuation.test(text)) return false;

  // Whole statements/calls, not keyword prefixes. Ambiguous lines remain spoken.
  return /^(?:import\s+(?:[\w$]+|\{[^}]+\}|\*\s+as\s+[\w$]+)\s+from\s+["'][^"']+["']|import\s+["'][^"']+["'])\s*;?$/.test(text) ||
    /^from\s+[\w.]+\s+import\s+\([^()]+\)\s*;?$/.test(text) ||
    /^(?:(?:const|let|var)\s+)?[\w$]+(?:\.[\w$]+|\[[^\]]+\])*\s*(?:[+*/-]?=|:=)\s*\S.*(?:;|,|[\]}])$/.test(text) ||
    // Literal-only assignments are strong evidence even without a JS semicolon.
    /^[\w$]+\s*=\s*(?:-?\d+(?:\.\d+)?|true|false|null|None|True|False|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(text) ||
    /^return\s+(?:[\w$]+(?:\.[\w$]+)*|[\w$]+\([^\n]*\))\s*;$/.test(text) ||
    /^\/\//.test(text) ||
    /^(?:[\w$]+\.)*[\w$]+\([^\n]*\)\s*;?$/.test(text) ||
    /^(?:if|for|while|switch|catch)\s*\([^\n]*\)\s*\{$/.test(text) ||
    /^(?:function\s+[\w$]+\([^\n]*\)|class\s+[\w$]+)\s*\{$/.test(text) ||
    /^def\s+\w+\([^\n]*\)\s*:$/.test(text) ||
    /^(?:\[(?:|[^\n]*[;{}()=:+*/\\<>"'`,][^\n]*)\]|\{(?:|[^\n]*[;{}()=:+*/\\<>"'`,][^\n]*)\})\s*[,;]?$/.test(text) ||
    /^[{}[\]);,]+$/.test(text);
}

/**
 * Prefer complete fences unless a code-only prefix establishes a selection starting
 * inside code. After that closing boundary, remain in recovery: omit recognizable
 * code while preserving unknown/prose lines, even if a later bare fence could pair.
 */
function speechLinesFromFences(markdown: string): MarkdownSpeechLine[] {
  const sourceLines: MarkdownSpeechLine[] = [];
  const pattern = /([^\r\n]*)(?:\r\n|\r|\n|$)/g;
  for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
    sourceLines.push({ text: match[1], sourceStart: match.index, sourceEnd: match.index + match[1].length });
    if (!match[0].length) break;
  }
  const raw = sourceLines.map(line => line.text);
  const output: MarkdownSpeechLine[] = [];
  const fencePattern = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
  const fences = raw.map((line) => line.match(fencePattern));
  const closingCache = new Map<string, number[]>();
  let hasPrefix = false;
  let codeOnlyPrefix = true;
  let recoverPartialCode = false;
  for (let index = 0; index < raw.length; index++) {
    const fence = fences[index];
    if (!fence) {
      if (!recoverPartialCode || !looksLikeCode(raw[index])) {
        output.push(sourceLines[index]);
        if (raw[index].trim()) { hasPrefix = true; codeOnlyPrefix &&= looksLikeCode(raw[index]); }
      }
      continue;
    }
    let next = index + 1;
    while (next < raw.length && !raw[next].trim()) next++;
    const nextContent = raw[next] ?? "";
    const obviousProse = !looksLikeCode(nextContent) &&
      (/^\s*(?:#{1,6}\s|[-*+]\s)/.test(nextContent) || /[\p{L}].*[.!?]$/u.test(nextContent.trim()));
    const codePrefix = hasPrefix && codeOnlyPrefix;
    // Index each marker length once; repeated unmatched fences do not rescan the tail.
    const key = `${fence[1][0]}:${fence[1].length}`;
    let positions = closingCache.get(key);
    if (!positions) {
      positions = [];
      for (let candidate = 0; candidate < fences.length; candidate++) {
        const end = fences[candidate];
        if (end && end[1][0] === fence[1][0] && end[1].length >= fence[1].length && !end[2].trim()) positions.push(candidate);
      }
      closingCache.set(key, positions);
    }
    let low = 0, high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] <= index) low = middle + 1;
      else high = middle;
    }
    const closing = positions[low] ?? -1;
    let taggedBeforeCloser = false;
    if (closing >= 0) {
      for (let candidate = index + 1; candidate < closing; candidate++) {
        const inner = fences[candidate];
        if (inner && inner[1][0] === fence[1][0] && inner[1].length >= fence[1].length && inner[2].trim()) {
          taggedBeforeCloser = true;
          break;
        }
      }
    }
    const complete = closing >= 0 && !taggedBeforeCloser;
    // A strongly evidenced code-only prefix establishes a closing boundary,
    // even if the selection ends inside a later bare fence. Otherwise prefer
    // a complete block; an unmatched bare fence may sit before obvious prose.
    if (!fence[2].trim() && (codePrefix || (!complete && obviousProse))) {
      if (codePrefix) output.length = 0;
      output.push({ kind: "code", text: "code block", sourceStart: codePrefix ? 0 : sourceLines[index].sourceStart, sourceEnd: sourceLines[index].sourceEnd });
      hasPrefix = true; codeOnlyPrefix = false;
      recoverPartialCode = codePrefix;
      continue;
    }
    output.push({ kind: "code", text: "code block", sourceStart: sourceLines[index].sourceStart, sourceEnd: sourceLines[complete ? closing : index].sourceEnd });
    hasPrefix = true; codeOnlyPrefix = false;
    if (complete) { index = closing; recoverPartialCode = false; }
    else recoverPartialCode = true;
  }
  return output;
}
