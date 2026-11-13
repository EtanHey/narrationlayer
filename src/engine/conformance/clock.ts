import type { Clock } from "./binding.js";
export class FakeClock implements Clock {
  private time = 0;
  private sequence = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  monotonic = () => this.time;
  schedule(delayMs: number, callback: () => void): () => void {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid fake delay");
    const id = this.sequence++;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return () => { this.tasks.delete(id); };
  }
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid fake advance");
    const end = this.time + ms;
    let steps = 0;
    await Promise.resolve();
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      if (++steps > 10000) throw new Error("fake clock did not quiesce");
      this.tasks.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
      await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve();
  }
}
