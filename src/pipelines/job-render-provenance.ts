import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VoiceLayerQwen3Config } from "../core/render-types.js";

let narrationlayerCommitCache: string | undefined;

export function getNarrationLayerCommit(config: VoiceLayerQwen3Config): string {
  if (config.narrationlayer_commit?.trim()) {
    return config.narrationlayer_commit.trim();
  }
  if (process.env.NARRATIONLAYER_COMMIT?.trim()) {
    return process.env.NARRATIONLAYER_COMMIT.trim();
  }
  if (narrationlayerCommitCache !== undefined) {
    return narrationlayerCommitCache;
  }
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: path.resolve(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  narrationlayerCommitCache =
    result.exitCode === 0 ? result.stdout.toString().trim() || "unknown" : "unknown";
  return narrationlayerCommitCache;
}

export async function getReferenceClipSha(config: VoiceLayerQwen3Config, referenceClip: string): Promise<string> {
  if (config.reference_clip_sha?.trim()) {
    return config.reference_clip_sha.trim();
  }
  try {
    return createHash("sha256").update(await readFile(referenceClip)).digest("hex");
  } catch {
    return "unknown";
  }
}
