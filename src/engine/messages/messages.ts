import { InvalidField, array as a, boolean as b, boundedString, integer as i, json, literal as e, number as n, offsetRange, profileRate, object as o, string as s, union as u, type Value } from "./schema";
const owner = e("user", "f5", "ask"), use = e("read", "speak", "ask_prompt"), mode = e("announce", "brief", "consult", "converse", "think");
const status = e("completed", "interrupted", "failed"), physical = e("exited", "unknown"), source = e("player_reported", "derived");
const engine = o({ family: e("qwen3_clone", "edge", "xtts", "f5"), legacy: b, clone: b, max_chars: i, timing: e("engine", "alignment", "none"), cancel: e("abort_only", "acknowledged"), available: b }, { reason: s });
export const limitsSchema = o({ max_chars: o({ read: i, speak: i, ask_prompt: i }), lookahead: i, aligner_reap_ms: i });
const current = { session_id: s, player_instance_id: s, control_epoch: i, audio_ms: i, piece_index: i, piece_start_ms: i, piece_duration_ms: i, duration_ms: i };
const timedWords = a(o({ index: i, start_ms: i, end_ms: i, timing: e("measured", "estimated") }));
const lifecycleBase = { session_id: s, piece_index: i, t_mono_ms: i };
const record = <const E extends string, R extends Record<string, import("./schema").Schema<unknown>>>(edge: E, fields: R) => o({ edge: e(edge), ...lifecycleBase, ...fields });
export const lifecycleSchema = u(
  record("synthesis_requested", { segment_index: i, chars: i, kind: s }),
  record("audio_ready", { duration_ms: i, sample_count: i, first_audible_offset_ms: i }),
  record("player_spawned", { player_instance_id: s, control_epoch: i }),
  record("first_sample", { player_instance_id: s, source }), record("first_audible", { player_instance_id: s, source }),
  record("last_sample", { player_instance_id: s, source }), record("player_exited", { player_instance_id: s, status, exit_code: i }),
);
const controlBase = { command_id: s, session_id: s };
const controlOptional = { expected_control_epoch: i, player_instance_id: s };
const control = <const P extends string, T>(op: P, args: import("./schema").Schema<T>) => o({ ...controlBase, op: e(op), args }, controlOptional);
export const controlSchema = u(
  control("pause", o({ owner }, { at_ms: i })), control("resume", o({ owner })),
  control("seek", u(o({ audio_ms: i }), o({ word_index: i }))),
  control("stop", o({ scope: e("session", "queue", "all_speech"), reason: e("stop", "cancel", "replaced") }, { at_ms: i, except_sessions: a(s), retain_read_queue: b })),
  control("replay", o({ of_session_id: s, from: e("start", "readback") }, { audio_ms: i })),
  control("next", o({ request_id: s })), control("previous", o({ request_id: s })), control("resync", o({})),
);
// Message bodies are flattened on the wire; keeping the envelope construction here avoids drift.
function message<const T extends string, R extends Record<string, import("./schema").Schema<unknown>>, O extends Record<string, import("./schema").Schema<unknown>> = Record<never, never>>(type: T, fields: R, optional?: O) { return o({ protocol: e("nl.engine/1"), type: e(type), ...fields }, optional); }
const event = <const T extends string, R extends Record<string, import("./schema").Schema<unknown>>, O extends Record<string, import("./schema").Schema<unknown>> = Record<never, never>>(type: T, fields: R, optional?: O) => message(type, { owner_epoch: i, seq: i, ...fields }, optional);
const tagged = <const T extends string, S>(type: T, schema: import("./schema").Schema<S>) => ({ json: { allOf: [message(type, {}).json, schema.json] }, read(v: unknown, p: string) { return { ...message(type, {}).read(v, p), ...schema.read(v, p) }; } });
const narrationBase = message("narrate", { request_id: boundedString(3, 128), idempotency_key: s, use, input: o({ text: s, format: e("plain", "markdown") }, { source: s, text_hash: s }), voice: o({ profile: s, require_clone: b, fallback: e("none", "declared") }), delivery: e("pieces", "play") }, { mode, rate: profileRate, start: u(e("now"), o({ after_session: s })), lookahead: i, selection_identity: s, queue: e("replace", "append"), retain_artifact: b });
const narration = { json: { allOf: [narrationBase.json, { if: { properties: { use: { const: "speak" } } }, then: { required: ["mode"] } }, { if: { properties: { use: { const: "ask_prompt" } } }, then: { required: ["retain_artifact"] } }] }, read(v: unknown, p: string) {
  const value = narrationBase.read(v, p);
  if (value.use === "speak") { if (value.mode === undefined) throw new InvalidField(`${p}.mode`); return { ...value, use: value.use, mode: value.mode }; }
  if (value.use === "ask_prompt") { if (value.retain_artifact === undefined) throw new InvalidField(`${p}.retain_artifact`); return { ...value, use: value.use, retain_artifact: value.retain_artifact }; }
  return { ...value, use: value.use };
} };
export const requests = {
  hello: message("hello", { client: o({ name: s, version: s }), binding: e("in-process", "process"), stage: e("A", "B"), required_caps: a(s) }, { optional_caps: a(s), audible: b, last_owner_epoch: i }),
  narrate: narration, 
  control: tagged("control", controlSchema), set_speed: message("set_speed", { command_id: s, speed: e(0.75, 1, 1.25, 1.5, 2) }),
  player_feedback: message("player_feedback", { session_id: s, control_epoch: i, player_instance_id: s, piece_index: i, edge: e("spawned", "first_sample", "first_audible", "last_sample", "exited"), t_mono_ms: i }, { source, exit: o({ status, stopped_at_ms: i }, { code: i }) }),
  speaker_grant: message("speaker_grant", { permit_id: s, admission_epoch: i, session_id: s, scope: s }),
  speaker_deny: message("speaker_deny", { session_id: s, reason: e("capture", "f5", "ask", "history", "disabled", "shutdown") }),
  speaker_revoke: message("speaker_revoke", { admission_epoch: i, reason: s }, { loan_id: s }),
  loan_restore: message("loan_restore", { loan_id: s, session_id: s }), capture_state: message("capture_state", { admission_epoch: i, capture: e("idle", "requested", "active", "processing") }),
};
export const events = {
  welcome: message("welcome", { owner_epoch: i, package_version: s, protocol_minor: i, caps: a(s), engines: a(engine), limits: limitsSchema }),
  accepted: event("accepted", { request_id: s, session_id: s, attempt_id: s }),
  control_ack: event("control_ack", { command_id: s, outcome: e("accept", "noop", "reject"), control_epoch: i }, { reason: s, offset_ms: i, clamped: b, current: o(current) }),
  plan: event("plan", { session_id: s, attempt_id: s, display_document: o({ version: e(1), text: s, speech_start: i, blocks: a(json) }), words: a(o({ index: i, text: s, display: offsetRange })), pieces: a(o({ piece_id: s, index: i, word_start: i, word_end: i, raw: b, segments: a(o({ word_start: i, word_end: i, kind: e("heading", "item", "sentence", "prompt"), pause_after_ms: i, pause_in: e("this_piece_end", "next_piece_start") })) })), engine: o({ family: s, profile_revision: s, voice: s }) }),
  piece_ready: event("piece_ready", { session_id: s, attempt_id: s, piece_id: s, index: i, start_ms: i, duration_ms: i, spoken_text: s, artifact: o({ handle: s, lease_id: s, format: s, sample_rate: i, sample_count: i, sha256: s }), words: timedWords, actual: a(o({ segment: i, engine: s, voice: s, substituted: b })), synthesis: o({ rate: s, attempts: a(json), unavailable: a(json), fallback_reason: u(s, e(null)) }), synthesis_ms: i }),
  timing_update: event("timing_update", { session_id: s, attempt_id: s, piece_id: s, derivation_id: s, words: timedWords }),
  duration: event("duration", { session_id: s, known_ms: i, final: b }),
  playback_started: event("playback_started", { session_id: s, control_epoch: i, player_instance_id: s, piece_index: i, at_audio_ms: i, rate: n }, { reanchor: s, amplitude: n }),
  position: event("position", { session_id: s, control_epoch: i, player_instance_id: s, audio_ms: i, word_index: i, piece_index: i, phase: e("playing", "waiting", "paused"), rate: n, duration_ms: i, final: b }),
  paused: event("paused", { session_id: s, control_epoch: i, player_instance_id: s, audio_ms: i, word_index: i, owner }),
  resumed: event("resumed", { session_id: s, control_epoch: i, player_instance_id: s, audio_ms: i, word_index: i, owner }),
  player_exited: event("player_exited", { session_id: s, player_instance_id: s, piece_index: i, status, reason: s, at_audio_ms: i }, { exit_code: i }),
  queue: event("queue", { depth: i, items: a(o({ session_id: s, priority: n, is_current: b, progress: n })), read_count: i, current_request_id: s }),
  outcome: event("outcome", { session_id: s, playback: o({ reason: e("completed", "stop", "stop_preparing", "cancel", "replaced", "synth_failed", "speech_failed", "player_failed", "refused", "resume_refused", "barge_in", "expired", "collapsed", "engine_absent", "shutdown") }), generation: o({ status: e("committed", "cancelled", "failed", "interrupted") }, { reason: s }), stopped_at_ms: i, word_index: i, heard: b, missing_piece_indices: a(i), physical, history: o({ route: s, state: s, reason: s }), artifacts: a(o({ piece_id: s, handle: s, lease_id: s })) }),
  snapshot: event("snapshot", { sessions: a(o({ session_id: s, request_id: s, phase: s, control_epoch: i, audio_ms: i, word_index: i, pieces_ready: i, last_seq: i }, { player_instance_id: s })) }),
  lifecycle: tagged("lifecycle", { json: { allOf: [event("lifecycle", {}).json, lifecycleSchema.json] }, read(v, p) { return { ...event("lifecycle", {}).read(v, p), ...lifecycleSchema.read(v, p) }; } }),
  engine_status: event("engine_status", { engines: a(engine) }),
  speaker_request: event("speaker_request", { session_id: s, player_instance_id: s, purpose: e("read", "speak", "ask_prompt", "returned_read") }),
  speaker_released: event("speaker_released", { permit_id: s, player_instance_id: s, physical, at_audio_ms: i }),
  aligner_quiet: event("aligner_quiet", { admission_epoch: i, child: e("reaped", "none", "unknown") }),
  error: event("error", { code: e("UNSUPPORTED_VERSION", "MISSING_CAPABILITY", "NOT_NEGOTIATED", "INVALID_REQUEST", "IDEMPOTENCY_CONFLICT", "INPUT_TOO_LONG", "VOICE_UNAVAILABLE", "ENGINE_UNAVAILABLE", "SYNTH_FAILED", "SYNTH_TIMEOUT", "STALE_EPOCH", "UNKNOWN_SESSION", "RESUME_REFUSED", "SPEAKER_DENIED", "PLAYER_FAILED", "ARTIFACT_EXPIRED", "BACKEND_DRAIN_UNKNOWN"), phase: e("negotiate", "admit", "plan", "synthesize", "assemble", "align", "deliver", "play", "control", "retain"), retry: e("never", "same_request", "new_request", "after_resync"), message: s }, { request_id: s, session_id: s, command_id: s, details: json }),
};
export type Request = Value<(typeof requests)[keyof typeof requests]>;
export type Event = Value<(typeof events)[keyof typeof events]>;
export type Message<T extends Request["type"] | Event["type"]> = Extract<Request | Event, { type: T }>;
export type LifecycleRecord = Value<typeof lifecycleSchema>;
export type Limits = Value<typeof limitsSchema>;
/** Stage restrictions are session policy; these metadata keep the wire definitions stage-aware. */
export const stages = { B: ["speaker_request", "speaker_grant", "speaker_deny", "speaker_revoke", "speaker_released", "loan_restore", "playback_started", "position", "paused", "resumed", "player_exited", "queue"], A: ["player_feedback"], controlsB: ["replay", "next", "previous"], narrateB: ["selection_identity", "queue", "play"] } as const;
