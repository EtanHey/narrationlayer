export function getWordsFromScript(script: string): string[] {
  return script
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
