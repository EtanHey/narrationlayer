import { synthesizeQwen3, Qwen3DaemonError } from "../../backends/qwen3-daemon.js";

import { RunnerFailure } from "./failure.js";

export async function synthesize(opts: {
  daemonUrl: string;
  authToken: string;
  referenceClip: string;
  referenceText: string;
  model?: string;
  text: string;
  timeoutMs: number;
}): Promise<Buffer> {
  try {
    const payload = await synthesizeQwen3({
      url: `${opts.daemonUrl.replace(/\/+$/, "")}/synthesize`,
      authToken: opts.authToken,
      body: {
        text: opts.text,
        reference_wav: opts.referenceClip,
        reference_text: opts.referenceText,
        ...(opts.model ? { model: opts.model } : {}),
      },
      timeoutMs: opts.timeoutMs,
    });
    return Buffer.from(payload.audioBase64, "base64");
  } catch (error) {
    if (!(error instanceof Qwen3DaemonError)) throw error;
    const failure = error.failure;
    if (failure.kind === "http") {
      throw new RunnerFailure(
        `daemon /synthesize failed (${failure.status}): ${failure.body || failure.statusText}`,
      );
    }
    if (failure.kind === "missing-audio") throw new RunnerFailure("daemon response missing audio_b64");
    throw failure.cause;
  }
}
