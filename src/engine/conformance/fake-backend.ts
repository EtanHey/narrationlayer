import type { BackendAudio, BackendStep, Clock, FakeBackend, Json } from "./binding.js";

/** Synthetic mono s16le WAV; metadata may deliberately disagree with decoded length. */
export function pcmAudio(samples: number, sample_rate = 1000, duration_ms = samples * 1000 / sample_rate, timings: Json = null): BackendAudio {
  if (!Number.isSafeInteger(samples) || samples < 0 || !Number.isSafeInteger(sample_rate) || sample_rate <= 0) throw new Error("invalid PCM shape");
  const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sample_rate, true); view.setUint32(28, sample_rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples * 2, true);
  return { bytes, samples, sample_rate, duration_ms, timings };
}

export class ScriptedBackend implements FakeBackend {
  private steps: BackendStep[] = [];
  private requests: Json[] = [];
  constructor(private clock: Clock) {}
  // Case-only request observations, never lifecycle records or logs; preserve text for case assertions.
  get calls(): readonly Json[] { return structuredClone(this.requests); }
  script(steps: readonly BackendStep[]): void { this.steps.push(...structuredClone(steps)); }
  synthesizeRequest(request: Json, signal: AbortSignal): Promise<BackendAudio> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("backend script exhausted"));
    return new Promise((resolve, reject) => {
      const abort = () => { cancel(); signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
      const cancel = this.clock.schedule(step.latency_ms, () => {
        signal.removeEventListener("abort", abort);
        if (step.result.kind === "error") reject(new Error(step.result.code));
        else { const { kind, ...audio } = step.result; resolve(structuredClone(audio)); }
      });
      if (!step.late_after_cancel) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
    });
  }
}
