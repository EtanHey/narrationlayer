import type { Event, Message } from "../messages/messages";
type Identity = Pick<Message<"accepted">, "owner_epoch" | "session_id" | "attempt_id">;
type Body<T extends Event> = T extends Event ? Omit<T, "protocol" | "owner_epoch" | "seq"> : never;
type Current = NonNullable<Message<"control_ack">["current"]>;
type Generation = Message<"outcome">["generation"]["status"] | "running";
type Playback = Message<"outcome">["playback"]["reason"];
type Receipt = { command: Message<"control">; ack: Message<"control_ack"> };
export type SessionState = Identity & {
  epoch_authority: "host" | "engine"; request: Message<"narrate">; plan: Body<Message<"plan">>;
  generation: Generation; playback: Playback | null; outcome: Message<"outcome"> | null;
  fenced: boolean; delivered: Body<Message<"piece_ready">>[]; started: boolean; eof: boolean;
  current: Current; receipts: Receipt[];
};
export type State = { owner_epoch: number; seq: number; sessions: Record<string, SessionState> };
export type Input =
  | { kind: "accept"; identity: Identity; current: Current; epoch_authority: SessionState["epoch_authority"]; request: Message<"narrate">; plan: Body<Message<"plan">> }
  | { kind: "control"; command: Message<"control">; target: Current }
  | { kind: "reanchor"; session_id: string; reason: "restart" | "speed"; target: Current }
  | { kind: "backend"; identity: Identity; result: { kind: "piece"; piece: Body<Message<"piece_ready">> } | { kind: "commit" } | { kind: "failure" } }
  | { kind: "feedback"; identity: Identity; feedback: Message<"player_feedback"> }
  | { kind: "stop"; session_id: string; reason: "stop" | "cancel" | "replaced" };
export type Effect = { kind: "emit" | "replay"; event: Event }
  | { kind: "backend"; identity: Identity; op: "start" | "cancel" };
function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${key(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** One serialisable value owns the binding counter and every session. */
export function initialState(owner_epoch: number): State { return { owner_epoch, seq: 0, sessions: {} }; }
/** Pure S2a transition; targets are pre-resolved cursors, not clock reads. */
export function reduce(state: State, input: Input): { state: State; effects: Effect[] } {
  const engine = structuredClone(state), effects: Effect[] = [];
  function emit(body: Body<Exclude<Event, Message<"welcome">>>): Event {
    // Contract L114: ONE sequence across every session and rejection in this owner epoch.
    const event: Event = { ...body, protocol: "nl.engine/1", owner_epoch: engine.owner_epoch, seq: ++engine.seq };
    effects.push({ kind: "emit", event }); return event;
  }
  const session_id = input.kind === "control" ? input.command.session_id : "identity" in input ? input.identity.session_id : input.session_id;
  const found = Object.hasOwn(engine.sessions, session_id) ? engine.sessions[session_id] : undefined;
  if (input.kind === "accept") {
    if (!found && input.identity.owner_epoch === engine.owner_epoch && input.plan.session_id === session_id && input.plan.attempt_id === input.identity.attempt_id) {
      engine.sessions = { ...engine.sessions, [session_id]: { ...input.identity, epoch_authority: input.epoch_authority, current: input.current, request: input.request, plan: input.plan,
        generation: "running", playback: null, outcome: null, fenced: false, delivered: [], started: false, eof: false, receipts: [] } };
      emit({ type: "accepted", request_id: input.request.request_id, session_id, attempt_id: input.identity.attempt_id });
      emit(input.plan); effects.push({ kind: "backend", identity: input.identity, op: "start" });
    }
    return { state: engine, effects };
  }
  function reject(code: "STALE_EPOCH" | "UNKNOWN_SESSION") {
    emit({ type: "error", code, phase: input.kind === "feedback" ? "deliver" : "control", retry: code === "STALE_EPOCH" ? "after_resync" : "never", message: code, session_id, ...(found ? { details: { current: found.current } } : {}) });
  }
  if (!found) {
    // Foreign asynchronous jobs are dropped (I02); addressed commands get UNKNOWN_SESSION.
    if (input.kind !== "feedback" && input.kind !== "backend") reject("UNKNOWN_SESSION");
    return { state: engine, effects };
  }
  const s = found;
  const identity = { owner_epoch: s.owner_epoch, session_id, attempt_id: s.attempt_id };
  function stop(reason: "stop" | "cancel" | "replaced") {
    // I03 / EndGeneration: logical cancellation never implies physical backend exit.
    if (s.generation === "running") { s.generation = "cancelled"; s.fenced = true; effects.push({ kind: "backend", identity, op: "cancel" }); }
    if (s.playback === null) s.playback = reason === "stop" && !s.started ? "stop_preparing" : reason;
  }
  function anchor(target: Current) { s.current = { ...target, session_id, control_epoch: s.epoch_authority === "engine" ? s.current.control_epoch + 1 : target.control_epoch }; }
  if (input.kind === "control") {
    const c = input.command, previous = s.receipts.find(r => r.command.command_id === c.command_id);
    // Contract L158: replay the first answer without allocating another seq.
    if (previous && key(previous.command) === key(c)) return { state, effects: [{ kind: "replay", event: previous.ack }] };
    const stale = c.op !== "stop" && ((c.expected_control_epoch !== undefined && c.expected_control_epoch !== s.current.control_epoch) || (c.player_instance_id !== undefined && c.player_instance_id !== s.current.player_instance_id) || (s.epoch_authority === "host" && input.target.control_epoch < s.current.control_epoch));
    let answer: "accept" | "noop" | "reject" = "accept", reason: string | undefined;
    if (previous) { answer = "reject"; reason = "command id reused"; }
    // ID-01 (no model backing): a stale control receives ONLY its ack with current.
    else if (stale) { answer = "reject"; reason = "STALE_EPOCH"; }
    else if (s.outcome || s.playback !== null) answer = "noop";
    else if (c.op === "stop") { if (!c.args.except_sessions?.includes(session_id)) stop(c.args.reason); else answer = "noop"; }
    else if (["pause", "resume", "seek"].includes(c.op)) anchor(input.target);
    else { answer = "reject"; reason = "control outside S2a"; }
    const ack: Message<"control_ack"> = { protocol: "nl.engine/1", type: "control_ack", owner_epoch: engine.owner_epoch, seq: engine.seq + 1, command_id: c.command_id, outcome: answer, control_epoch: s.current.control_epoch, ...(reason ? { reason } : {}), ...(stale ? { current: s.current } : {}) };
    emit(ack); if (!previous) s.receipts = [...s.receipts, { command: c, ack }].slice(-32);
  } else if (!s.outcome) { // Operative I03 fence: cancelled attempts already have their outcome; no late delivery.
    if (input.kind === "stop") stop(input.reason);
    else if (input.kind === "reanchor") {
      if (s.epoch_authority === "host" && input.target.control_epoch < s.current.control_epoch) reject("STALE_EPOCH");
      else if (s.playback === null) anchor(input.target);
    } else {
      // I02 / Feedback(j,o,a): binding supplies owner/attempt; wire session is checked BEFORE epochs.
      const matches = input.identity.owner_epoch === s.owner_epoch && input.identity.session_id === s.session_id && input.identity.attempt_id === s.attempt_id;
      if (!matches || (input.kind === "feedback" && input.feedback.session_id !== session_id)) return { state, effects: [] };
      if (input.kind === "backend") {
        if (s.generation !== "running") return { state, effects: [] };
        if (input.result.kind === "piece") {
          const p = input.result.piece, expected = s.plan.pieces[s.delivered.length];
          if (expected && p.session_id === session_id && p.attempt_id === s.attempt_id && p.index === expected.index && p.piece_id === expected.piece_id) { s.delivered.push(p); emit(p); }
        } else if (input.result.kind === "commit") {
          // I04 / Seal + Commit: complete coverage for N planned pieces.
          if (s.delivered.length === s.plan.pieces.length) s.generation = "committed";
        } else { s.generation = "failed"; s.fenced = true; if (s.playback === null) s.playback = "speech_failed"; }
      } else {
        const f = input.feedback;
        if (s.playback !== null) return { state, effects: [] }; // I01: EOF before publication still locks playback.
        // ID-01 (no model backing): host generations may advance; engine feedback never mints epochs.
        const epochOK = s.epoch_authority === "host" ? f.control_epoch >= s.current.control_epoch : f.control_epoch === s.current.control_epoch;
        if (!epochOK) { reject("STALE_EPOCH"); return { state: engine, effects }; }
        if (f.edge === "spawned" && (f.piece_index === s.current.piece_index || f.piece_index === s.current.piece_index + 1) && s.delivered.some(p => p.index === f.piece_index)) s.current = { ...s.current, player_instance_id: f.player_instance_id, piece_index: f.piece_index };
        if (f.player_instance_id !== s.current.player_instance_id) { reject("STALE_EPOCH"); return { state: engine, effects }; }
        if (f.piece_index !== s.current.piece_index) return { state, effects: [] };
        if (s.epoch_authority === "host") s.current.control_epoch = f.control_epoch;
        if (f.edge === "first_sample" && s.delivered.some(p => p.index === f.piece_index)) s.started = true;
        if (f.edge === "exited" && f.exit) {
          // I04 / Feedback: natural EOF requires actual start and ALL delivered pieces.
          if (f.exit.status === "completed" && s.started && s.delivered.length === s.plan.pieces.length && f.piece_index === s.plan.pieces.at(-1)?.index) { s.eof = true; s.playback = "completed"; }
          else if (f.exit.status === "failed") { stop("stop"); s.playback = "player_failed"; }
        }
      }
    }
  }
  // I01 / Step: independent immutable terminals; publication failure may follow natural EOF.
  if (!s.outcome && s.generation !== "running" && s.playback !== null) {
    const body: Body<Message<"outcome">> = { type: "outcome", session_id, playback: { reason: s.playback }, generation: { status: s.generation }, stopped_at_ms: s.current.audio_ms, word_index: 0, heard: s.started, physical: "unknown",
      missing_piece_indices: s.plan.pieces.filter(p => !s.delivered.some(d => d.index === p.index)).map(p => p.index), history: { route: "host", state: "unconfirmed", reason: "mirror" }, artifacts: s.delivered.map(p => ({ piece_id: p.piece_id, handle: p.artifact.handle, lease_id: p.artifact.lease_id })) };
    s.outcome = { ...body, protocol: "nl.engine/1", owner_epoch: engine.owner_epoch, seq: engine.seq + 1 }; emit(body);
  }
  return { state: engine, effects };
}
