import type { ArtifactPort, PublicationContext, PublishedPiece } from "../publication/publication";
import { nextSynthesisIndex } from "../reducer/pacing";
import { hasDeliveredLease, initialState, reduce, type Input } from "../reducer/session";
import { negotiate, parseEvent, parseRequest } from "../messages/parser";
import type { Event, Limits, Message } from "../messages/messages";
import { VoiceUnavailable, type Substitution } from "../selection/voice";
type Identity = Pick<Message<"accepted">, "owner_epoch" | "session_id" | "attempt_id">;
type Plan = Omit<Message<"plan">, "protocol" | "owner_epoch" | "seq">;
/** Returned plans and requests become engine-owned; the session detaches them before storage. */
export interface ReadPlanner {
  plan(request: Message<"narrate">, limits: Limits, identity: Identity): { plan: Plan; requests: readonly { piece_index: number; text: string }[]; selection?: Substitution };
}
export interface Clock {
  now(): number;
  monotonic(): number;
  schedule(ms: number, callback: () => void): () => void;
}
export interface Backend<Audio> {
  synthesizeRequest(request: { piece_index: number; text: string }, signal: AbortSignal): Promise<Audio>;
}
/** S4/S7 supply decoded timing and artifact receipts; this session never interprets audio.
 * Returned receipts become engine-owned; the session detaches them before storage. */
export type Publication<Audio> = {
  piece(audio: Audio, context: PublicationContext, signal: AbortSignal): Promise<PublishedPiece>;
  commit(identity: Identity, signal: AbortSignal): Promise<void>;
} & ({ release: ArtifactPort["release"] } | {
  // Throw-only fixtures own no receipts; every publication that returns one must release it.
  piece(audio: Audio, context: PublicationContext, signal: AbortSignal): Promise<never>;
});
/** Only reducer state owns terminals/cursors/order. Other state: synthesis requests (text
 * absent from reducer), id counter (epoch-local minting), abort handles (physical work),
 * outgoing queue (transport), including its closed flag and pending iterator readers. */
export function createEngineSession<Audio>(options: {
  owner_epoch: number;
  welcome: Pick<Message<"welcome">, "package_version" | "protocol_minor" | "caps" | "engines">;
  limits: Limits;
  planner: ReadPlanner;
  clock: Clock;
  backend: Backend<Audio>;
  publication: Publication<Audio>;
  artifacts?: { releaseFromHost(lease_id: string): { kind: "released" | "expired" }; minted(lease_id: string): boolean };
  observe?: { input?(input: Input<"host">): void; event?(event: Event, replay: boolean): void };
}) {
  let state = initialState(options.owner_epoch, "host"), counter = 0;
  const requests = new Map<string, readonly { piece_index: number; text: string }[] & { selection?: Substitution }>();
  const runs = new Set<Promise<void>>();
  let shutdownPromise: Promise<void> | undefined;
  const aborts = new Map<string, AbortController>();
  const queue: Event[] = [], readers: ((result: IteratorResult<Event>) => void)[] = [];
  let closed = false, shuttingDown = false, negotiated = false;
  const events: AsyncIterable<Event> = { [Symbol.asyncIterator]() { return { next(): Promise<IteratorResult<Event>> {
    const value = queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => readers.push(resolve));
  } }; } };
  function emit(event: Event, replay: boolean) {
    if (closed) return;
    const copy = structuredClone(event), reader = readers.shift();
    if (reader) reader({ done: false, value: copy }); else queue.push(copy);
    options.observe?.event?.(structuredClone(event), replay);
  }
  function step(input: Input<"host">, details?: Message<"error">["details"]) {
    options.observe?.input?.(structuredClone(input));
    const id = "identity" in input ? input.identity.session_id : "session_id" in input ? input.session_id : input.kind === "control" ? input.command.session_id : undefined;
    const wasRunning = id !== undefined && state.sessions[id]?.generation === "running";
    const result = reduce(state, input);
    state = result.state;
    for (const effect of result.effects) {
      if (effect.kind === "emit" || effect.kind === "replay") emit(effect.event.type === "error" && details ? { ...effect.event, details } : effect.event, effect.kind === "replay");
      else if (effect.kind === "plan") plan(effect.request);
      else if (effect.kind === "backend") {
        if (effect.op === "cancel") {
          const id = effect.identity.session_id, abort = aborts.get(id);
          if (abort) queueMicrotask(() => { if (aborts.get(id) === abort) abort.abort(); });
        }
        else pump(effect.identity.session_id);
      }
    }
    if (id !== undefined) {
      pump(id);
      if (wasRunning && state.sessions[id]?.generation !== "running") pumpDependents(id);
    }
  }
  function pumpDependents(id: string) {
    if (closed) return;
    for (const session of Object.values(state.sessions)) {
      const start = session.request.start;
      if (start && typeof start === "object" && start.after_session === id) pump(session.session_id);
    }
  }
  function pump(id: string) {
    const session = Object.hasOwn(state.sessions, id) ? state.sessions[id] : undefined;
    if (!session) return;
    if (closed || shuttingDown || aborts.has(id) || session.generation !== "running" || session.fenced) {
      if (session.generation !== "running") requests.delete(id);
      return;
    }
    const start = session.request.start;
    // The pure rule releases logical generation; this handle gates physical settlement.
    if (start && typeof start === "object" && aborts.has(start.after_session)) return;
    if (session.delivered.length !== session.plan.pieces.length
      && nextSynthesisIndex(session, session.request.lookahead ?? options.limits.lookahead, state.sessions) === undefined) return;
    const abort = new AbortController();
    aborts.set(id, abort);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    runs.add(pending); // Register before invoking a host backend that can call shutdown.
    queueMicrotask(() => {
      void run({ owner_epoch: session.owner_epoch, session_id: id, attempt_id: session.attempt_id }, abort)
        .then(() => { runs.delete(pending); finish(); }, () => { runs.delete(pending); finish(); });
    });
  }
  // §2.5: reducer owns contract phase/retry selection for every refusal code.
  function refuse(code: Extract<Input<"host">, { kind: "refuse" }>["code"], request_id?: string) {
    step({ kind: "refuse", code, message: code, ...(request_id ? { request_id } : {}) });
  }
  function plan(request: Message<"narrate">) {
    // §3 L270-271: epoch plus monotone counter; no random or wall-clock identity.
    const n = ++counter;
    const identity = {
      owner_epoch: state.owner_epoch,
      session_id: `session-${state.owner_epoch}-${n}`,
      attempt_id: `attempt-${state.owner_epoch}-${n}`,
    };
    let prepared: ReturnType<ReadPlanner["plan"]>;
    try {
      const planned = options.planner.plan(structuredClone(request), structuredClone(options.limits), identity);
      prepared = structuredClone(planned);
      const checked = parseEvent({ ...prepared.plan, protocol: "nl.engine/1", owner_epoch: state.owner_epoch, seq: state.seq + 1 });
      if (!checked.ok || checked.value?.type !== "plan"
        || prepared.plan.session_id !== identity.session_id || prepared.plan.attempt_id !== identity.attempt_id
        || prepared.plan.pieces.some(p => p.segments.length === 0)
        || prepared.requests.length !== prepared.plan.pieces.length
        || prepared.requests.some((r, i) => r.piece_index !== prepared.plan.pieces[i].index)) throw new Error("invalid plan");
      requests.set(identity.session_id, Object.assign(prepared.requests, { selection: prepared.selection }));
    } catch (error) {
      requests.delete(identity.session_id);
      refuse(error instanceof VoiceUnavailable ? "VOICE_UNAVAILABLE" : "INVALID_REQUEST", request.request_id);
      return;
    }
    // §2 L116: accept emits the complete plan before its backend-start effect.
    step({ kind: "accept", identity, request, plan: prepared.plan, current: {
      session_id: identity.session_id, player_instance_id: "", control_epoch: 0,
      audio_ms: 0, piece_index: 0, piece_start_ms: 0, piece_duration_ms: 0, duration_ms: 0,
    } });
  }
  async function run(identity: Identity, abort: AbortController) {
    try {
      // §2 L114: strict prefix, one synthesis in flight; parked reads hold no timer.
      while (state.sessions[identity.session_id].generation === "running") {
        const session = state.sessions[identity.session_id], index = session.delivered.length;
        const piece = session.plan.pieces[index];
        if (!piece) {
          await options.publication.commit(identity, abort.signal);
          step({ kind: "backend", identity, result: { kind: "commit" } }); break;
        }
        if (nextSynthesisIndex(session, session.request.lookahead ?? options.limits.lookahead, state.sessions) === undefined) break;
        const plannedRequests = requests.get(identity.session_id), selection = plannedRequests?.selection;
        const request = plannedRequests?.[index];
        if (!request || request.piece_index !== piece.index || !piece.segments[0]) throw new Error("invalid planner requests");
        const started = options.clock.monotonic();
        step({ kind: "synthesis_requested", identity, piece_index: piece.index, chars: request.text.length, t_mono_ms: Math.round(started) });
        const audio = await options.backend.synthesizeRequest(request, abort.signal);
        const ready = options.clock.monotonic();
        abort.signal.throwIfAborted();
        const delivered = await options.publication.piece(audio, {
          ...identity, index: piece.index, piece_id: piece.piece_id,
          prefix: session.delivered.map(p => ({ sample_count: p.artifact.sample_count, sample_rate: p.artifact.sample_rate })),
          words: structuredClone(session.plan.words.slice(piece.word_start, piece.word_end)),
          // Engine selection owes the resolved profile/mode rate when the request omits it.
          engine: { ...session.plan.engine }, substituted: selection?.substituted ?? false,
          fallback_reason: selection?.fallback_reason ?? null, segments: piece.segments.length, rate: session.request.rate ?? "+0%",
          synthesis_ms: ready - started, spoken_text: request.text,
        }, abort.signal);
        // §3 L282: stop during publication still goes through the attempt fence.
        try {
          const { known_ms, first_audible_offset_ms, ...receipt } = structuredClone(delivered);
          step({ kind: "backend", identity, result: { kind: "piece", piece: receipt, known_ms,
            audio_ready: { t_mono_ms: Math.round(ready), first_audible_offset_ms } } });
        } finally {
          if (!state.sessions[identity.session_id].delivered.some(p => p.artifact.lease_id === delivered.artifact.lease_id)
            && "release" in options.publication)
            options.publication.release(delivered.artifact.lease_id);
        }
        const updated = state.sessions[identity.session_id];
        if (updated.generation === "running" && updated.delivered.length === index) throw new Error("publication receipt rejected");
      }
    } catch {
      // §2.5 L220: reducer emits a text-free error and the one terminal outcome.
      step({ kind: "backend", identity, result: { kind: "failure", error: { code: "SYNTH_FAILED", message: "synthesis or publication failed" } } });
    } finally {
      aborts.delete(identity.session_id);
      if (state.sessions[identity.session_id].generation !== "running") requests.delete(identity.session_id);
      pump(identity.session_id);
      if (state.sessions[identity.session_id].generation !== "running") pumpDependents(identity.session_id);
    }
  }
  return {
    events,
    send(message: unknown): void {
      if (closed) {
        const parsed = parseRequest(message, options.limits);
        if (parsed.ok && parsed.value.type === "artifact_release" && hasDeliveredLease(state, parsed.value.lease_id))
          options.artifacts?.releaseFromHost(parsed.value.lease_id);
        return;
      }
      if (!negotiated) {
        const result = negotiate(message, { ...structuredClone(options.welcome), protocol: "nl.engine/1", type: "welcome", owner_epoch: options.owner_epoch, limits: structuredClone(options.limits) });
        if (result.ok) { negotiated = true; emit(result.value, false); }
        else {
          const request_id = message !== null && typeof message === "object" && "type" in message && message.type === "narrate" && "request_id" in message && typeof message.request_id === "string" && message.request_id.length >= 3 && message.request_id.length <= 128 ? message.request_id : undefined;
          step({ kind: "refuse", code: result.error.code, message: result.error.code, ...(request_id ? { request_id } : {}) }, result.error.details);
          if (result.error.code === "UNSUPPORTED_VERSION" || result.error.code === "MISSING_CAPABILITY") {
            closed = true;
            for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
          }
        }
        return;
      }
      const parsed = parseRequest(message, options.limits);
      if (!parsed.ok) {
        const request_id = message !== null && typeof message === "object" && "type" in message && message.type === "narrate" && "request_id" in message && typeof message.request_id === "string" && message.request_id.length >= 3 && message.request_id.length <= 128 ? message.request_id : undefined;
        refuse(parsed.error.code, request_id); return;
      }
      const value = parsed.value;
      if (value.type === "artifact_release") {
        if (!options.artifacts) { refuse("INVALID_REQUEST"); return; }
        // Decide in host request order; only the store's byte-port delete is deferred.
        const result = hasDeliveredLease(state, value.lease_id) ? options.artifacts.releaseFromHost(value.lease_id) : { kind: "expired" };
        if (result.kind === "released") step({ kind: "artifact_release", lease_id: value.lease_id });
        else if (result.kind === "expired") step({ kind: "refuse", code: "ARTIFACT_EXPIRED", message: "ARTIFACT_EXPIRED" },
          options.artifacts.minted(value.lease_id) ? { lease_id: value.lease_id } : undefined);
      } else if (value.type === "narrate") step({ kind: "admit", request: value }); // §2.2 L137: reducer owns admission/replay.
      else if (value.type === "control" && value.op === "stop") {
        const current = state.sessions[value.session_id]?.current;
        if (current) step({ kind: "control", command: value, target: current });
        else step({ kind: "stop", session_id: value.session_id, reason: value.args.reason });
      } else if (value.type === "player_feedback") {
        const session = state.sessions[value.session_id];
        if (session) step({ kind: "feedback", identity: { owner_epoch: session.owner_epoch, session_id: session.session_id, attempt_id: session.attempt_id }, feedback: value }); // §2.3 L174: host owns player.
      } else {
        // Owed to S5: unsupported control correlation; refuse cannot carry command_id/session_id yet.
        refuse("INVALID_REQUEST");
      }
    },
    shutdown(deadline: number): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      // Block pumping, but publish every outcome before closing the event stream.
      shuttingDown = true;
      const active = [...runs];
      for (const session of Object.values(state.sessions)) if (!session.outcome)
        step({ kind: "shutdown", session_id: session.session_id });
      closed = true;
      for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
      shutdownPromise = new Promise<void>(resolve => {
        queueMicrotask(() => {
          const remaining = deadline - options.clock.now();
          if (!(remaining > 0)) { resolve(); return; }
          const cancel = Number.isFinite(remaining) ? options.clock.schedule(remaining, resolve) : () => {};
          void Promise.allSettled(active).then(() => { cancel(); resolve(); });
        });
      });
      return shutdownPromise;
    },
  };
}
