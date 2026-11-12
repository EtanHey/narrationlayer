import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VoiceLayerQwen3Config } from "../../core/render-types.js";

export function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "~", value.slice(2));
  }
  return value;
}

export async function loadAuthToken(config: VoiceLayerQwen3Config): Promise<string | undefined> {
  if (config.auth_token?.trim()) {
    return config.auth_token.trim();
  }
  const tokenFile =
    config.auth_token_file ||
    process.env.VOICELAYER_TTS_DAEMON_SECRET_FILE ||
    process.env.VOICELAYER_TTS_AUTH_TOKEN_FILE;
  if (!tokenFile) {
    return undefined;
  }
  return (await readFile(path.resolve(expandHome(tokenFile)), "utf8")).trim();
}

export async function loadReferenceText(config: VoiceLayerQwen3Config): Promise<string> {
  if (config.reference_text?.trim()) {
    return config.reference_text.trim();
  }
  if (!config.reference_text_path?.trim()) {
    throw new Error("voicelayer-qwen3 requires reference_text or reference_text_path");
  }
  return (await readFile(path.resolve(expandHome(config.reference_text_path)), "utf8")).trim();
}

export function getReferenceClip(config: VoiceLayerQwen3Config): string {
  const referenceClip = config.reference_clip || config.reference_clips?.[0];
  if (!referenceClip?.trim()) {
    throw new Error("voicelayer-qwen3 requires reference_clip or reference_clips");
  }
  return path.resolve(expandHome(referenceClip));
}
