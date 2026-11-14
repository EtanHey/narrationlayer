import type { Voices } from "../selection/voice";
import type { Message } from "../messages/messages";
// S1 owns wire schemas. These ports accept structured-clone-safe JSON without importing that slice.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Clock {
  now(): number;
  monotonic(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
export type BackendAudio = { bytes: Uint8Array; samples: number; sample_rate: number; duration_ms: number; timings: Json };
export type BackendStep = { latency_ms: number; result: ({ kind: "audio" } & BackendAudio) | { kind: "error"; code: string }; late_after_cancel: boolean };
export interface FakeBackend {
  script(steps: readonly BackendStep[]): void;
  synthesizeRequest(request: Json, signal: AbortSignal): Promise<BackendAudio>;
  readonly calls: readonly Json[];
}
export interface FakePlayer {
  play(artifact: Json): string;
  stop(id: string): void;
  readonly edges: readonly Json[];
}
export interface FakeSpawn {
  start(argv: readonly string[]): { id: string; exited: Promise<number>; kill(): void };
  readonly calls: readonly (readonly string[])[];
}
export interface HostStub {
  capture(state: "requested" | "active" | "idle"): void;
  permit(session: string): void;
  revoke(session: string, loan_id?: string): void;
  loan(from: string, to: string): void;
  readonly records: readonly Json[];
}
export type FakePorts = { backend: FakeBackend; player: FakePlayer; spawn: FakeSpawn; host: HostStub };
export interface Connection {
  resolve?(handle: string, lease_id: string): { kind: "resolved"; bytes: Uint8Array } | { kind: "expired" | "failed" };
  send(message: Json): void;
  events: AsyncIterable<Json>;
  shutdown(deadline: number): Promise<void>;
}
export interface Binding {
  name: string;
  // Host-selected bound (positive safe integer <= 2147483647); a supplied value must be honoured.
  // S0a2 supplies the optional ports; S0a's harness-only bindings need only the clock.
  create(host: { synthesis_timeout_ms?: number; voices?: Voices; engines?: Message<"welcome">["engines"]; clock: Clock; ports?: FakePorts; hash_key: Uint8Array; store: Map<string, Uint8Array>; audible: boolean }): Connection;
}
