import type { Event, Message } from "../messages/messages";
type Identity = Pick<Message<"accepted">, "owner_epoch" | "session_id" | "attempt_id">;
type Body<T extends Event> = T extends Event ? Omit<T, "protocol" | "owner_epoch" | "seq"> : never;
type Current = NonNullable<Message<"control_ack">["current"]>;
type Generation = Message<"outcome">["generation"]["status"] | "running";
type Playback = Message<"outcome">["playback"]["reason"];
type Receipt = { command: Message<"control">; ack: Message<"control_ack"> };
export type SessionState = Identity & {
  request: Message<"narrate">; plan: Body<Message<"plan">>;
  generation: Generation; playback: Playback | null; outcome: Message<"outcome"> | null;
  fenced: boolean; delivered: Body<Message<"piece_ready">>[]; started: boolean; eof: boolean;
  current: Current; job_epoch: number; previous: Pick<Current, "player_instance_id" | "piece_index"> | null; receipts: Receipt[];
};
type AdmissionError = Omit<Body<Message<"error">>, "code" | "phase" | "retry" | "session_id" | "command_id"> & (
  | { code: "INVALID_REQUEST" | "INPUT_TOO_LONG"; phase: "admit" | "plan"; retry: "never" }
  | { code: "VOICE_UNAVAILABLE"; phase: "admit" | "plan"; retry: "new_request" }
  | { code: "NOT_NEGOTIATED"; phase: "negotiate"; retry: "after_resync" }
);
type SynthesisError = Pick<Message<"error">, "message"> & { code: "SYNTH_FAILED" | "SYNTH_TIMEOUT" | "ENGINE_UNAVAILABLE" | "VOICE_UNAVAILABLE" };
type Authority = "host" | "engine";
export type State<A extends Authority = Authority> = { owner_epoch: number; epoch_authority: A; seq: number; sessions: Record<string, SessionState>; admissions: Record<string, { session_id: string; accepted: Message<"accepted"> }> };
export type Input<A extends Authority = Authority> =
  | (A extends "engine" ? { kind: "reanchor"; session_id: string; reason: "restart" | "speed"; target: Current } : never)
  | { kind: "admit"; request: Message<"narrate"> }
  | { kind: "refuse"; error: AdmissionError }
  | { kind: "accept"; identity: Identity; current: Current; request: Message<"narrate">; plan: Body<Message<"plan">> }
  | { kind: "control"; command: Message<"control">; target: Current }
  | { kind: "backend"; identity: Identity; result: { kind: "piece"; piece: Body<Message<"piece_ready">> } | { kind: "commit" } | { kind: "failure"; error: SynthesisError } }
  | { kind: "feedback"; identity: Identity; feedback: Message<"player_feedback"> }
  | { kind: "stop"; session_id: string; reason: "stop" | "cancel" | "replaced" };
export type Effect = { kind: "plan"; request: Message<"narrate"> } | { kind: "emit" | "replay"; event: Event }
  | { kind: "backend"; identity: Identity; op: "start" | "cancel" }
  | { kind: "reject"; reason: "HOST_REANCHOR" | "UNKNOWN_SESSION" | "TERMINAL" };
function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${key(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** One serialisable value owns the binding counter and every session. */
export function initialState<A extends Authority>(owner_epoch: number, epoch_authority: A): State<A> { return { owner_epoch, epoch_authority, seq: 0, sessions: {}, admissions: {} }; }
/** Pure S2a transition; targets are pre-resolved cursors, not clock reads. */
export function reduce<A extends Authority>(state: State<A>, input: Input<NoInfer<A>>): { state: State<A>; effects: Effect[] };
export function reduce(state: State, input: Input): { state: State; effects: Effect[] } {
  const engine = structuredClone(state); input = structuredClone(input);
  const effects: Effect[] = [];
  function emit(body: Body<Exclude<Event, Message<"welcome">>>): Event {
    // Contract L114: ONE sequence across every session and rejection in this owner epoch.
    const event: Event = { ...body, protocol: "nl.engine/1", owner_epoch: engine.owner_epoch, seq: ++engine.seq };
    effects.push({ kind: "emit", event }); return event;
  }
  if (input.kind === "refuse") { emit(input.error); return { state: engine, effects }; }
  if (input.kind === "admit") {
    const k = input.request.idempotency_key, receipt = Object.hasOwn(engine.admissions, k) ? engine.admissions[k] : undefined;
    if (!receipt) return { state, effects: [{ kind: "plan", request: input.request }] };
    if (key(engine.sessions[receipt.session_id].request) === key(input.request)) return { state, effects: [{ kind: "replay", event: receipt.accepted }] };
    emit({ type: "error", code: "IDEMPOTENCY_CONFLICT", phase: "admit", retry: "never", message: "idempotency key reused", request_id: input.request.request_id });
    return { state: engine, effects };
  }
  const session_id = input.kind === "control" ? input.command.session_id : "identity" in input ? input.identity.session_id : input.session_id;
  if (input.kind === "reanchor" && engine.epoch_authority === "host") return { state, effects: [{ kind: "reject", reason: "HOST_REANCHOR" }] };
  const found = Object.hasOwn(engine.sessions, session_id) ? engine.sessions[session_id] : undefined;
  if (input.kind === "accept") {
    // The session must ask admit first; a duplicate accept never starts work again.
    if (Object.hasOwn(engine.admissions, input.request.idempotency_key)) return { state, effects };
    if (!found && input.identity.owner_epoch === engine.owner_epoch && input.plan.session_id === session_id && input.plan.attempt_id === input.identity.attempt_id) {
      engine.sessions = { ...engine.sessions, [session_id]: { ...input.identity, current: input.current, job_epoch: input.current.control_epoch, previous: null, request: input.request, plan: input.plan,
        generation: "running", playback: null, outcome: null, fenced: false, delivered: [], started: false, eof: false, receipts: [] } };
      const accepted: Message<"accepted"> = { type: "accepted", protocol: "nl.engine/1", owner_epoch: engine.owner_epoch, seq: engine.seq + 1, request_id: input.request.request_id, session_id, attempt_id: input.identity.attempt_id };
      engine.admissions = { ...engine.admissions, [input.request.idempotency_key]: { session_id, accepted } }; emit(accepted);
      emit(input.plan); effects.push({ kind: "backend", identity: input.identity, op: "start" });
    }
    return { state: engine, effects };
  }
  function reject(code: "STALE_EPOCH" | "UNKNOWN_SESSION") {
    emit({ type: "error", code, phase: input.kind === "feedback" ? "deliver" : "control", retry: code === "STALE_EPOCH" ? "after_resync" : "never", message: code, session_id, ...(found ? { details: { current: found.current } } : {}) });
  }
  if (!found) {
    // Foreign asynchronous jobs are dropped (I02); addressed commands get UNKNOWN_SESSION.
    if (input.kind === "reanchor") effects.push({ kind: "reject", reason: "UNKNOWN_SESSION" });
    else if (input.kind !== "feedback" && input.kind !== "backend") reject("UNKNOWN_SESSION");
    return { state: engine, effects };
  }
  const s = found;
  if (input.kind === "reanchor" && (s.outcome || s.playback !== null)) return { state, effects: [{ kind: "reject", reason: "TERMINAL" }] };
  const identity = { owner_epoch: s.owner_epoch, session_id, attempt_id: s.attempt_id };
  function stop(reason: "stop" | "cancel" | "replaced") {
    // I03 / EndGeneration: logical cancellation never implies physical backend exit.
    if (s.generation === "running") { s.generation = "cancelled"; s.fenced = true; effects.push({ kind: "backend", identity, op: "cancel" }); }
    if (s.playback === null) s.playback = reason === "stop" && !s.started ? "stop_preparing" : reason;
  }
  function anchor(target: Current) { s.previous = null; s.current = { ...target, session_id, control_epoch: engine.epoch_authority === "engine" ? s.current.control_epoch + 1 : target.control_epoch }; }
  if (input.kind === "control") {
    const c = input.command, previous = s.receipts.find(r => r.command.command_id === c.command_id);
    // Contract L158: replay the first answer without allocating another seq.
    if (previous && key(previous.command) === key(c)) return { state, effects: [{ kind: "replay", event: previous.ack }] };
    const stale = c.op !== "stop" && ((c.expected_control_epoch !== undefined && c.expected_control_epoch !== s.current.control_epoch) || (c.player_instance_id !== undefined && c.player_instance_id !== s.current.player_instance_id) || (engine.epoch_authority === "host" && input.target.control_epoch < s.current.control_epoch));
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
  } else if (!s.outcome) { // Domain generation terminal below fences late backend delivery (I03).
    if (input.kind === "stop") stop(input.reason);
    else if (input.kind === "reanchor") {
      anchor(input.target);
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
        } else { emit({ type: "error", ...input.result.error, phase: "synthesize", retry: "new_request", session_id }); s.generation = "failed"; s.fenced = true; if (s.playback === null) s.playback = "speech_failed"; }
      } else {
        const f = input.feedback;
        if (s.playback !== null) return { state, effects: [] }; // I01: EOF before publication still locks playback.
        // ID-01 (no model backing): host generations may advance; engine feedback never mints epochs.
        const epochOK = engine.epoch_authority === "host" ? f.control_epoch >= s.current.control_epoch : f.control_epoch === s.current.control_epoch;
        if (!epochOK) { reject("STALE_EPOCH"); return { state: engine, effects }; }
        const moved = f.control_epoch > s.current.control_epoch;
        const previousExit = f.edge === "exited" && !moved && s.previous?.player_instance_id === f.player_instance_id && s.previous.piece_index === f.piece_index;
        if (previousExit) {
          s.previous = null;
          if (f.exit?.status === "failed") { stop("stop"); s.playback = "player_failed"; }
        } else {
          const next = f.piece_index === s.current.piece_index + 1;
          const restart = f.piece_index === s.current.piece_index && (f.player_instance_id === s.current.player_instance_id || f.control_epoch > s.job_epoch);
          if (f.edge === "spawned" && (next || restart) && s.delivered.some(p => p.index === f.piece_index)) {
            if (next) s.previous = !moved ? { player_instance_id: s.current.player_instance_id, piece_index: s.current.piece_index } : null;
            s.current = { ...s.current, player_instance_id: f.player_instance_id, piece_index: f.piece_index }; s.job_epoch = f.control_epoch;
          }
          if (f.player_instance_id !== s.current.player_instance_id) { reject("STALE_EPOCH"); return { state: engine, effects }; }
          if (f.piece_index !== s.current.piece_index) return { state, effects: [] };
          if (moved) s.previous = null;
          if (engine.epoch_authority === "host") { s.current.control_epoch = f.control_epoch; s.job_epoch = f.control_epoch; }
        if (f.edge === "first_sample" && s.delivered.some(p => p.index === f.piece_index)) s.started = true;
        if (f.edge === "exited" && f.exit) {
          // I04 / Feedback: natural EOF requires actual start and ALL delivered pieces.
          if (f.exit.status === "completed" && s.started && s.delivered.length === s.plan.pieces.length && f.piece_index === s.plan.pieces.at(-1)?.index) { s.eof = true; s.playback = "completed"; }
          else if (f.exit.status === "failed") { stop("stop"); s.playback = "player_failed"; }
        }
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
