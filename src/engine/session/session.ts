import { initialState, reduce, type Input } from "../reducer/session";
import { parseRequest } from "../messages/parser";
import type { Event, Limits, Message } from "../messages/messages";
type Identity = Pick<Message<"accepted">, "owner_epoch" | "session_id" | "attempt_id">;
type Plan = Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
type Piece = Omit<Message<"piece_ready">, "protocol" | "owner_epoch" | "seq">;
type Refusal = Extract<Input, { kind: "refuse" }>["error"];
export class PlanningError extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}
export interface ReadPlanner {
  plan(request: Message<"narrate">, limits: Limits, identity: Identity): { plan: Plan; requests: readonly { piece_index: number; text: string }[] };
}
export interface Clock { monotonic(): number; schedule(ms: number, callback: () => void): () => void }
export interface Backend<Audio> {
  synthesizeRequest(request: { piece_index: number; text: string }, signal: AbortSignal): Promise<Audio>;
}
/** S4/S7 supply decoded timing and artifact receipts; this session never interprets audio. */
export interface Publication<Audio> {
  piece(audio: Audio, context: Identity & { index: number; piece_id: string; start_ms: number; synthesis_ms: number; spoken_text: string }, signal: AbortSignal): Promise<Piece>;
  commit(identity: Identity, signal: AbortSignal): Promise<void>;
}
/** Only reducer state owns terminals/cursors/order. Other state: synthesis requests (text
 * absent from reducer), id counter (epoch-local minting), abort handles (physical work),
 * outgoing queue (transport), including its closed flag and pending iterator readers. */
export function createEngineSession<Audio>(options: {
  owner_epoch: number; limits: Limits; planner: ReadPlanner; clock: Clock; backend: Backend<Audio>; publication: Publication<Audio>;
  observe?: { input?(input: Input<"host">): void; event?(event: Event, replay: boolean): void };
}) {
  let state = initialState(options.owner_epoch, "host"), counter = 0;
  const requests = new Map<string, readonly { piece_index: number; text: string }[]>();
  const aborts = new Map<string, AbortController>();
  const queue: Event[] = [], readers: ((result: IteratorResult<Event>) => void)[] = [];
  let closed = false;
  const events: AsyncIterable<Event> = { [Symbol.asyncIterator]() { return { next(): Promise<IteratorResult<Event>> {
    const value = queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => readers.push(resolve));
  } }; } };
  function emit(event: Event, replay: boolean) {
    const copy = structuredClone(event), reader = readers.shift();
    if (reader) reader({ done: false, value: copy }); else queue.push(copy);
    options.observe?.event?.(structuredClone(event), replay);
  }
  function step(input: Input<"host">) {
    options.observe?.input?.(structuredClone(input));
    const result = reduce(state, input); state = result.state;
    for (const effect of result.effects) {
      if (effect.kind === "emit" || effect.kind === "replay") emit(effect.event, effect.kind === "replay");
      else if (effect.kind === "plan") plan(effect.request);
      else if (effect.kind === "backend") {
        if (effect.op === "cancel") aborts.get(effect.identity.session_id)?.abort();
        else { const abort = new AbortController(); aborts.set(effect.identity.session_id, abort); void run(effect.identity, abort); }
      }
    }
  }
  function plan(request: Message<"narrate">) {
    // §3 L270-271: epoch plus monotone counter; no random or wall-clock identity.
    const n = ++counter, identity = { owner_epoch: state.owner_epoch, session_id: `session-${state.owner_epoch}-${n}`, attempt_id: `attempt-${state.owner_epoch}-${n}` };
    try {
      const prepared = options.planner.plan(structuredClone(request), structuredClone(options.limits), identity);
      requests.set(identity.session_id, structuredClone(prepared.requests));
      // §2 L116: accept emits the complete plan before its backend-start effect.
      step({ kind: "accept", identity, request, plan: prepared.plan, current: { session_id: identity.session_id, player_instance_id: "", control_epoch: 0, audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 0, duration_ms: 0 } });
    } catch (error) {
      requests.delete(identity.session_id);
      step({ kind: "refuse", error: error instanceof PlanningError ? { ...error.refusal, request_id: request.request_id } : { type: "error", code: "INVALID_REQUEST", phase: "plan", retry: "never", message: "planning failed", request_id: request.request_id } });
    }
  }
  async function run(identity: Identity, abort: AbortController) {
    try {
      // §2 L114: strict prefix, one call at a time. Pacing/retry belong to S3b-2.
      while (state.sessions[identity.session_id].generation === "running") {
        const session = state.sessions[identity.session_id], index = session.delivered.length;
        const piece = session.plan.pieces[index];
        if (!piece) {
          await options.publication.commit(identity, abort.signal);
          step({ kind: "backend", identity, result: { kind: "commit" } }); break;
        }
        const request = requests.get(identity.session_id)?.[index];
        if (!request || request.piece_index !== piece.index) throw new Error("invalid planner requests");
        const started = options.clock.monotonic();
        const audio = await options.backend.synthesizeRequest(request, abort.signal);
        const delivered = await options.publication.piece(audio, { ...identity, index: piece.index, piece_id: piece.piece_id, start_ms: session.delivered.reduce((sum, p) => sum + p.duration_ms, 0), synthesis_ms: options.clock.monotonic() - started, spoken_text: request.text }, abort.signal);
        // §3 L282: every late result still goes through the reducer's attempt fence.
        step({ kind: "backend", identity, result: { kind: "piece", piece: delivered } });
      }
    } catch {
      // §2.5 L220: reducer emits a text-free error and the one terminal outcome.
      step({ kind: "backend", identity, result: { kind: "failure", error: { code: "SYNTH_FAILED", message: "synthesis or publication failed" } } });
    } finally { aborts.delete(identity.session_id); requests.delete(identity.session_id); }
  }
  return {
    events,
    send(message: unknown): void {
      if (closed) return;
      const parsed = parseRequest(message, options.limits);
      if (!parsed.ok) {
        // Protocol negotiation is outside this Stage A straight-path port.
        step({ kind: "refuse", error: { type: "error", code: parsed.error.code === "INPUT_TOO_LONG" ? "INPUT_TOO_LONG" : "INVALID_REQUEST", phase: "admit", retry: "never", message: parsed.error.message } }); return;
      }
      const value = parsed.value;
      if (value.type === "narrate") step({ kind: "admit", request: value }); // §2.2 L137: reducer owns admission/replay.
      else if (value.type === "control" && value.op === "stop") {
        const current = state.sessions[value.session_id]?.current;
        if (current) step({ kind: "control", command: value, target: current });
        else step({ kind: "stop", session_id: value.session_id, reason: value.args.reason });
      } else if (value.type === "player_feedback") {
        const session = state.sessions[value.session_id];
        if (session) step({ kind: "feedback", identity: { owner_epoch: session.owner_epoch, session_id: session.session_id, attempt_id: session.attempt_id }, feedback: value }); // §2.3 L174: host owns player.
      } else step({ kind: "refuse", error: { type: "error", code: "INVALID_REQUEST", phase: "admit", retry: "never", message: "outside straight-path session" } });
    },
    async shutdown(_deadline: number): Promise<void> {
      if (closed) return;
      for (const session of Object.values(state.sessions)) if (!session.outcome) step({ kind: "stop", session_id: session.session_id, reason: "cancel" });
      closed = true;
      for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
    },
  };
}
