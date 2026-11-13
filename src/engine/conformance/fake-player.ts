import type { Clock, FakePlayer, FakeSpawn, Json } from "./binding.js";

export type SpawnStep = { exit_ms: number; exit_code: number };
export type PlayerStep = SpawnStep & { argv: readonly string[]; first_sample_ms: number; first_audible_ms: number; last_sample_ms: number };
export class ScriptedSpawn implements FakeSpawn {
  private steps: SpawnStep[] = [];
  private argv: string[][] = [];
  private sequence = 0;
  constructor(private clock: Clock) {}
  get calls(): readonly (readonly string[])[] { return structuredClone(this.argv); }
  script(steps: readonly SpawnStep[]): void { this.steps.push(...structuredClone(steps)); }
  start(argv: readonly string[], step = this.steps.shift(), onExit: (code: number, killed: boolean) => void = () => {}) {
    if (!step) throw new Error("spawn script exhausted");
    if (!Number.isFinite(step.exit_ms) || step.exit_ms < 0 || !Number.isInteger(step.exit_code)) throw new Error("invalid spawn step");
    const id = `player-${++this.sequence}`;
    this.argv.push([...argv]);
    let kill = () => {};
    const exited = new Promise<number>(resolve => {
      let done = false;
      const finish = (code: number, killed: boolean) => {
        if (done) return;
        done = true; cancel(); onExit(code, killed); resolve(code);
      };
      const cancel = this.clock.schedule(step.exit_ms, () => finish(step.exit_code, false));
      kill = () => finish(137, true);
    });
    return { id, exited, kill: () => kill() };
  }
}

export class ScriptedPlayer implements FakePlayer {
  private steps: PlayerStep[] = [];
  private records: Json[] = [];
  private live = new Map<string, () => void>();
  constructor(private clock: Clock, readonly spawn = new ScriptedSpawn(clock)) {}
  get edges(): readonly Json[] { return structuredClone(this.records); }
  script(steps: readonly PlayerStep[]): void {
    for (const s of steps) {
      const times = [0, s.first_sample_ms, s.first_audible_ms, s.last_sample_ms, s.exit_ms];
      if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1])) || !Number.isInteger(s.exit_code)) throw new Error("unordered player edges");
    }
    this.steps.push(...structuredClone(steps));
  }
  play(artifact: Json): string {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || typeof artifact.session_id !== "string" || !Number.isInteger(artifact.piece_index) || !Number.isInteger(artifact.control_epoch)) throw new Error("player identity required");
    const step = this.steps.shift();
    if (!step) throw new Error("player script exhausted");
    const identity = { session_id: artifact.session_id, piece_index: artifact.piece_index, control_epoch: artifact.control_epoch };
    const cancellations: (() => void)[] = [];
    const edge = (name: string, extra: { [key: string]: Json } = {}) => this.records.push({ ...identity, player_instance_id: process.id, edge: name, t_mono_ms: this.clock.monotonic(), source: "player_reported", ...extra });
    // Exit is registered after sample edges, including equal-time ties.
    for (const [name, delay] of [["first_sample", step.first_sample_ms], ["first_audible", step.first_audible_ms], ["last_sample", step.last_sample_ms]] as const) cancellations.push(this.clock.schedule(delay, () => edge(name)));
    const process = this.spawn.start(step.argv, step, (code, killed) => {
      cancellations.forEach(cancel => cancel()); this.live.delete(process.id);
      edge("player_exited", { exit_code: code, status: killed ? "interrupted" : code === 0 ? "completed" : "failed" });
    });
    this.live.set(process.id, process.kill); edge("player_spawned");
    return process.id;
  }
  stop(id: string): void { this.live.get(id)?.(); }
}
