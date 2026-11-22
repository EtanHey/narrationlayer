/** Prose alternatives: two alphabetic words, excluding explicit paths, routes,
 * units, established slash idioms and code. Keep this pattern mirrored in Swift. */
export const proseSlashPattern = /(?<![\p{L}\p{M}\p{N}\p{S}\p{Cf}_./\\:`~-])(?!(?:TCP\/IP|he\/she|assets\/[A-Za-z]+)(?![A-Za-z]))[A-Za-z]{2,}\/[A-Za-z]{2,}(?=(?:[.,;!?):\]"'’]*)(?:\s|$|,(?=[A-Za-z]{2,}\/)))/gu;

/** A paragraph separator marks an audio-chunk context boundary in fallback documents.
 * URLs, equal-length backtick spans and link targets stay lexical. */
export function proseSlashMatches(text: string) {
  const pattern = new RegExp("https?:\\/\\/[^\\s<>]+|www\\.[^\\s<>]+|(`+)(?!`)[^\\u2029]*?(?<!`)\\1(?!`)|\\]\\([^\\n\\u2029]*?\\)|" + proseSlashPattern.source, "gu");
  return Array.from(text.matchAll(pattern)).filter(m => !/^(?:https?:\/\/|www\.|`|\]\()/.test(m[0]));
}

/** Keep slash glyphs in the raw display, attached to the following word. */
export function displayTokens(text: string): {0: string; index: number}[] {
  const cuts = new Set(proseSlashMatches(text).map(m => m.index + m[0].indexOf("/")));
  return Array.from(text.matchAll(/\S+/gu)).flatMap(m => {
    const boundaries = [m.index, ...Array.from(cuts).filter(at => at > m.index && at < m.index + m[0].length), m.index + m[0].length];
    return boundaries.slice(0, -1).map((at, i) => ({0: m[0].slice(at - m.index, boundaries[i + 1] - m.index), index: at}));
  });
}
