import { prepareSpeechChannels } from "../text-normalize.js";

export function getWordsFromScript(script: string): string[] {
  return prepareSpeechChannels(script).displayText
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
