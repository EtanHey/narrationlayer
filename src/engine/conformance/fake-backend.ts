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
  private highWater = 0;
  private active = new Set<{ waiting: boolean }>();
  constructor(private clock: Clock) {}
  // Case-only request observations, never lifecycle records or logs; preserve text for case assertions.
  get calls(): readonly Json[] { return structuredClone(this.requests); }
  get peak(): number { return this.highWater; }
  get pending(): number { return this.steps.length + this.active.size; }
  assertDrained(): void {
    if (this.pending) throw new Error(`backend: ${this.steps.length} unused steps, ${this.active.size} pending requests${[...this.active].some(s => s.waiting) ? "; late_after_cancel step was never cancelled" : ""}`);
  }
  script(steps: readonly BackendStep[]): void {
    steps.forEach((s, index) => {
      const known = (value: object, keys: string[]) => Object.keys(value).every(k => keys.includes(k));
      const r = s?.result;
      if (!s || typeof s !== "object" || Array.isArray(s) || !known(s, ["latency_ms", "late_after_cancel", "result"]) || !Number.isFinite(s.latency_ms) || s.latency_ms < 0 || typeof s.late_after_cancel !== "boolean" || !r || typeof r !== "object" || Array.isArray(r) ||
        (r.kind !== "audio" && r.kind !== "error") || (r.kind === "error" ? !known(r, ["kind", "code"]) || typeof r.code !== "string" :
          !known(r, ["kind", "bytes", "samples", "sample_rate", "duration_ms", "timings"]) || !(r.bytes instanceof Uint8Array) || !Number.isSafeInteger(r.samples) || r.samples < 0 || r.bytes.length !== 44 + r.samples * 2 ||
          !Number.isSafeInteger(r.sample_rate) || r.sample_rate <= 0 || !Number.isFinite(r.duration_ms) || r.duration_ms < 0 || r.timings === undefined)) throw new Error(`invalid backend step ${index}`);
    });
    this.steps.push(...structuredClone(steps));
  }
  synthesizeRequest(request: Json, signal: AbortSignal): Promise<BackendAudio> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("backend script exhausted"));
    const state = { waiting: step.late_after_cancel }; this.active.add(state); this.highWater = Math.max(this.highWater, this.active.size);
    return new Promise((resolve, reject) => {
      let cancel = () => {};
      const deliver = () => {
        this.active.delete(state); signal.removeEventListener("abort", abort);
        if (step.result.kind === "error") reject(new Error(step.result.code));
        else { const { kind, ...audio } = step.result; resolve(structuredClone(audio)); }
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        if (step.late_after_cancel) { state.waiting = false; cancel = this.clock.schedule(step.latency_ms, deliver); }
        else { cancel(); this.active.delete(state); reject(new Error("cancelled")); }
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (!step.late_after_cancel) cancel = this.clock.schedule(step.latency_ms, deliver);
    });
  }
}
