export interface Qwen3Synthesis {
  audioBase64: string;
  elapsedGenerationMs: unknown;
  audioDurationMs: unknown;
  words: unknown;
  word_timings: unknown;
  word_boundaries: unknown;
  loraApplied: unknown;
}

type Failure =
  | { kind: "http"; status: number; body: string; statusText: string }
  | { kind: "missing-audio"; payload: unknown }
  | { kind: "timeout" | "abort" | "network" | "malformed-json"; cause: unknown };

export class Qwen3DaemonError extends Error {
  constructor(readonly failure: Failure) {
    super(`Qwen3 daemon: ${failure.kind}`, "cause" in failure ? { cause: failure.cause } : undefined);
  }
}

export async function synthesizeQwen3(args: {
  url: string;
  authToken: string;
  body: object;
  timeoutMs: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}): Promise<Qwen3Synthesis> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) abort();
  else args.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, args.timeoutMs);
  try {
    let response: Response;
    try {
      response = await (args.fetchImpl ?? fetch)(args.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.authToken}`,
        },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new Qwen3DaemonError({ kind: timedOut ? "timeout" : controller.signal.aborted ? "abort" : "network", cause });
    } finally {
      // Both legacy callers bounded the fetch only, not response body consumption.
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Qwen3DaemonError({ kind: "http", status: response.status, body, statusText: response.statusText });
    }
    // Keep the legacy property read: JSON null raises its original TypeError.
    try {
      const payload = await response.json() as Record<string, unknown>;
      if (typeof payload.audio_b64 !== "string" || !payload.audio_b64) {
        throw new Qwen3DaemonError({ kind: "missing-audio", payload });
      }
      return {
        audioBase64: payload.audio_b64,
        elapsedGenerationMs: payload.duration_ms,
        audioDurationMs: payload.audio_duration_ms,
        words: payload.words,
        word_timings: payload.word_timings,
        word_boundaries: payload.word_boundaries,
        loraApplied: payload.lora_applied,
      };
    } catch (cause) {
      if (cause instanceof Qwen3DaemonError) throw cause;
      throw new Qwen3DaemonError({ kind: controller.signal.aborted ? "abort" : "malformed-json", cause });
    }
  } finally {
    args.signal?.removeEventListener("abort", abort);
  }
}
