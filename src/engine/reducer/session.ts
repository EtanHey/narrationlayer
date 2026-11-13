import type { Event, Message } from "../messages/messages";
type Identity = Pick<Message<"accepted">, "owner_epoch" | "session_id" | "attempt_id">;
type Body<T extends Event> = T extends Event ? Omit<T, "protocol" | "owner_epoch" | "seq"> : never;
type Current = NonNullable<Message<"control_ack">["current"]>;
type Generation = Message<"outcome">["generation"]["status"] | "running";
type Playback = Message<"outcome">["playback"]["reason"];
type Receipt = { command: Message<"control">; ack: Message<"control_ack"> };
export type State = Identity & {
  seq: number; request: Message<"narrate"> | null; plan: Body<Message<"plan">> | null;
  generation: Generation; playback: Playback | null; outcome: Message<"outcome"> | null;
  fenced: boolean; delivered: Body<Message<"piece_ready">>[]; started: boolean; eof: boolean;
  current: Current; receipts: Receipt[];
};
export type Input =
  | { kind: "accept"; request: Message<"narrate">; plan: Body<Message<"plan">> }
  | { kind: "control"; command: Message<"control">; target: Current }
  | { kind: "backend"; identity: Identity; result: { kind: "piece"; piece: Body<Message<"piece_ready">> } | { kind: "commit" } | { kind: "failure" } }
  | { kind: "feedback"; identity: Identity; feedback: Message<"player_feedback"> }
  | { kind: "stop"; reason: "stop" | "cancel" | "replaced" };
export type Effect = { kind: "emit" | "replay"; event: Event }
  | { kind: "backend"; identity: Identity; op: "start" | "cancel" }
  | { kind: "reject"; code: Message<"error">["code"]; current: Current };
function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${key(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Identities and the initial player mirror are assigned by the caller, never minted here. */
export function initialState(identity: Identity, current: Current): State {
  return { ...identity, current, seq: 0, request: null, plan: null, generation: "running", playback: null,
    outcome: null, fenced: false, delivered: [], started: false, eof: false, receipts: [] };
}
/** Pure S2a transition; target is a pre-resolved cursor, not a request to read a clock. */
export function reduce(state: State, input: Input): { state: State; effects: Effect[] } {
  const s: State = structuredClone(state), effects: Effect[] = [];
  const identity = { owner_epoch: s.owner_epoch, session_id: s.session_id, attempt_id: s.attempt_id };
  function emit(body: Body<Exclude<Event, Message<"welcome">>>): Event {
    // Contract L114: the binding serialises these returned effects in acceptance order.
    const event: Event = { ...body, protocol: "nl.engine/1", owner_epoch: s.owner_epoch, seq: ++s.seq };
    effects.push({ kind: "emit", event }); return event;
  }
  function reject(code: Message<"error">["code"]) { effects.push({ kind: "reject", code, current: s.current }); }
  function finish() {
    // I01 / Step: independent generation and playback terminals; first outcome wins.
    if (s.outcome || s.generation === "running" || s.playback === null) return;
    const body: Body<Message<"outcome">> = { type: "outcome", session_id: s.session_id,
      playback: { reason: s.playback }, generation: { status: s.generation },
      stopped_at_ms: s.current.audio_ms, word_index: 0, heard: s.started, physical: "unknown",
      missing_piece_indices: s.plan!.pieces.filter(p => !s.delivered.some(d => d.index === p.index)).map(p => p.index),
      history: { route: "host", state: "unconfirmed", reason: "mirror" }, artifacts: s.delivered.map(p => ({ piece_id: p.piece_id, handle: p.artifact.handle, lease_id: p.artifact.lease_id })) };
    s.outcome = { ...body, protocol: "nl.engine/1", owner_epoch: s.owner_epoch, seq: s.seq + 1 }; emit(body);
  }
  function stop(reason: "stop" | "cancel" | "replaced") {
    // I03 / EndGeneration: logical cancellation never implies physical backend exit.
    if (s.generation === "running") { s.generation = "cancelled"; s.fenced = true; effects.push({ kind: "backend", identity, op: "cancel" }); }
    if (s.playback === null) s.playback = reason === "stop" && !s.started ? "stop_preparing" : reason;
  }
  if (input.kind === "accept") {
    if (!s.request && input.plan.session_id === s.session_id && input.plan.attempt_id === s.attempt_id) {
      s.request = input.request; s.plan = input.plan;
      emit({ type: "accepted", request_id: input.request.request_id, session_id: s.session_id, attempt_id: s.attempt_id });
      emit({ ...input.plan, type: "plan" }); effects.push({ kind: "backend", identity, op: "start" });
    }
  } else if (input.kind === "control") {
    const c = input.command;
    if (c.session_id !== s.session_id || !s.request) reject("UNKNOWN_SESSION");
    else {
      const previous = s.receipts.find(r => r.command.command_id === c.command_id);
      // Contract L158: replay the first answer without emitting a new sequenced event.
      if (previous && key(previous.command) === key(c)) return { state, effects: [{ kind: "replay", event: previous.ack }] };
      const stale = (c.expected_control_epoch !== undefined && c.expected_control_epoch !== s.current.control_epoch) || (c.player_instance_id !== undefined && c.player_instance_id !== s.current.player_instance_id);
      let answer: "accept" | "noop" | "reject" = "accept", reason: string | undefined;
      if (previous) { answer = "reject"; reason = "command id reused"; }
      // ID-01 (no model backing): fence same-session old controls/player restarts.
      else if (stale) { answer = "reject"; reason = "STALE_EPOCH"; reject("STALE_EPOCH"); }
      else if (s.outcome || s.playback !== null) answer = "noop";
      else if (c.op === "stop") { if (!c.args.except_sessions?.includes(s.session_id)) stop(c.args.reason); else answer = "noop"; }
      else if (["pause", "resume", "seek"].includes(c.op)) s.current = { ...input.target, session_id: s.session_id, control_epoch: s.current.control_epoch + 1 };
      else { answer = "reject"; reason = "control outside S2a"; }
      const ack: Message<"control_ack"> = { protocol: "nl.engine/1", type: "control_ack", owner_epoch: s.owner_epoch, seq: s.seq + 1, command_id: c.command_id, outcome: answer, control_epoch: s.current.control_epoch, ...(reason ? { reason } : {}), ...(stale ? { current: s.current } : {}) };
      emit(ack);
      if (!previous) s.receipts = [...s.receipts, { command: c, ack }].slice(-32);
    }
  } else if (s.request && !s.outcome) {
    if (input.kind === "stop") stop(input.reason);
    else {
      // I02 / Feedback(j,o,a): foreign identity cannot move any live state.
      const matches = input.identity.owner_epoch === s.owner_epoch && input.identity.session_id === s.session_id && input.identity.attempt_id === s.attempt_id;
      if (!matches) return { state, effects: [] };
      if (input.kind === "backend") {
        // I03 / Deliver, Commit: late results cannot cross a logical fence.
        if (s.fenced || s.generation !== "running") return { state, effects: [] };
        if (input.result.kind === "piece") {
          const p = input.result.piece, expected = s.plan!.pieces[s.delivered.length];
          if (expected && p.session_id === s.session_id && p.attempt_id === s.attempt_id && p.index === expected.index && p.piece_id === expected.piece_id) { s.delivered.push(p); emit({ ...p, type: "piece_ready" }); }
        } else if (input.result.kind === "commit") {
          // I04 / Seal + Commit: complete coverage for N planned pieces.
          if (s.delivered.length === s.plan!.pieces.length) s.generation = "committed";
        } else { s.generation = "failed"; s.fenced = true; if (s.playback === null) s.playback = "speech_failed"; }
      } else {
        const f = input.feedback;
        // ID-01 (no model backing): the pair, not player id alone, identifies a job.
        if (f.control_epoch !== s.current.control_epoch || f.player_instance_id !== s.current.player_instance_id) { reject("STALE_EPOCH"); return { state, effects }; }
        if (f.session_id !== s.session_id || f.piece_index !== s.current.piece_index || s.playback !== null || s.fenced) return { state, effects: [] };
        if (f.edge === "first_sample" && s.delivered.some(p => p.index === f.piece_index)) s.started = true;
        if (f.edge === "exited" && f.exit) {
          // I04 / Feedback: natural EOF requires actual start and ALL delivered pieces.
          if (f.exit.status === "completed" && s.started && s.delivered.length === s.plan!.pieces.length && f.piece_index === s.plan!.pieces.at(-1)?.index) { s.eof = true; s.playback = "completed"; }
          else if (f.exit.status === "failed") { stop("stop"); s.playback = "player_failed"; }
        }
      }
    }
  }
  finish(); return { state: s, effects };
}
