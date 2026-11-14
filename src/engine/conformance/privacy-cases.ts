import { format } from "node:util";
import type { Case, CaseContext } from "./runner";
import type { Json } from "./binding";
import { ScriptedBackend, pcmAudio } from "./fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "./fake-player";
import { ScriptedHost } from "./host-stub";
const hello = { protocol: "nl.engine/1", type: "hello", client: { name: "synthetic", version: "1" }, binding: "in-process", stage: "A", required_caps: [] };
export const privacyText = "Zephyrine quillwort marbles the lanternfish harbour. Obsidian thimbleweed outruns nine velvet cormorants.";
const hostId = "synthetic-host-identifier-quartz-falcon";
// Eight characters catches partial snippets, including object keys, without
// confusing ordinary short protocol words with the invented read text.
export const privacyRuns = Array.from({ length: privacyText.length - 7 }, (_, i) => privacyText.slice(i, i + 8));
export const hasReadText = (value: string) => privacyRuns.some(run => value.includes(run));
const obj = (v: Json | undefined) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
function outsideText(event: Json) {
  const e = obj(structuredClone(event));
  if (e.type === "plan") {
    delete obj(e.display_document).text; delete obj(e.display_document).blocks;
    if (Array.isArray(e.words)) for (const word of e.words) delete obj(word).text;
  }
  if (e.type === "piece_ready") delete e.spoken_text;
  return JSON.stringify(e);
}
const read = (text = privacyText, extra: Record<string, Json> = {}) => ({ protocol: "nl.engine/1", type: "narrate", request_id: hostId, idempotency_key: hostId, use: "read", input: { text, format: "plain" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", ...extra });
const modes = ["plain", "markdown", "failure", "limit", "conflict", "host-ids", "metadata", "unknown-stop", "invalid", "stop", "shutdown", "queued", "release", "unknown-control", "second-hello", "pre-hello", "second-read", "heading", "list", "code", "label", "url"];
export const privacyCases: Record<string, Case> = { "PRIV-01e": async c => {
  c.assert(privacyText.length >= 96 && new Set(privacyRuns).size === privacyRuns.length);
  for (const mode of modes) await scenario(c, mode);
} };
async function scenario(c: CaseContext, mode: string) {
  const logs: string[] = [], restores: (() => void)[] = [];
  const wrap = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key); c.assert(Reflect.set(target, key, replacement));
    c.assert(Reflect.get(target, key) === replacement); restores.push(() => { Reflect.set(target, key, original); });
  };
  try {
    for (const key of ["log", "info", "warn", "error", "debug"]) wrap(console, key, (...args: unknown[]) => { logs.push(format(...args)); });
    for (const stream of [process.stdout, process.stderr]) wrap(stream, "write", (chunk: unknown, ...args: unknown[]) => {
      logs.push(typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : format(chunk));
      const callback = args.at(-1); if (typeof callback === "function") callback(); return true;
    });
    // Entry publishes reports on fd 3; these seven log routes do not carry it.
    for (const key of ["log", "info", "warn", "error", "debug"] as const) console[key]("synthetic observer check");
    process.stdout.write("synthetic observer check"); process.stderr.write("synthetic observer check"); c.assert(logs.length === 7);
    const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
    const synthesize = backend.synthesizeRequest.bind(backend);
    backend.synthesizeRequest = (request, signal) => {
      backend.script([{ latency_ms: 1, late_after_cancel: false, result: (mode === "failure" || mode === "second-read" && backend.calls.length >= 2) ? { kind: "error", code: privacyText.slice(0, 24) } : { kind: "audio", ...pcmAudio(100) } }]);
      return synthesize(request, signal);
    };
    const connection = c.binding.create({ clock: c.clock, ports: { backend, spawn, player, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32).fill(1), audible: false });
    const seen: Json[] = []; let ended = false, error: unknown;
    void (async () => { try { for await (const e of connection.events) seen.push(structuredClone(e)); } catch (e) { error = e; } finally { ended = true; } })();
    const tick = async (ms = 0) => { await c.clock.advance(ms); for (let i = 0; i < 128; i++) await Promise.resolve(); if (error) throw error; };
    const events = (type: string) => seen.map(obj).filter(e => e.type === type);
    const wait = async (predicate: () => boolean) => { for (let i = 0; i < 24 && !predicate(); i++) await tick(1); c.assert(predicate()); };
    const complete = async (id: string) => {
      const a = events("accepted").find(e => e.request_id === id); c.assert(Boolean(a));
      for (const p of events("piece_ready").filter(e => e.session_id === a?.session_id)) for (const edge of ["spawned", "first_sample", "exited"])
        connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, player_instance_id: `privacy-player-${p.index}`, control_epoch: Number(p.index) + 1, piece_index: p.index, edge, t_mono_ms: c.clock.now(), ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: Number(p.start_ms) + Number(p.duration_ms) } } : {}) });
      await tick();
      c.assert(events("outcome").some(e => e.session_id === a?.session_id && obj(e.playback).reason === "completed"));
    };
    if (mode !== "pre-hello") connection.send(hello);
    let document = privacyText, markdown = false;
    if (["markdown", "heading", "list", "code", "label", "url"].includes(mode)) {
      markdown = true;
      document = mode === "heading" ? `# ${privacyText}` : mode === "list" ? `- ${privacyText}` : mode === "code" ? `\`${privacyText}\`` : mode === "label" ? `[${privacyText}](https://example.invalid)` : mode === "url" ? `https://example.invalid/${privacyText.replaceAll(" ", "-")}` : `# ${privacyText.slice(0, 50)}\n\n- ${privacyText.slice(51)}`;
    }
    if (mode === "limit") document += " x".repeat(501);
    const request = read(document, { input: { text: document, format: markdown ? "markdown" : "plain" } });
    if (mode === "host-ids") Object.assign(request, { request_id: hostId + "-opaque", idempotency_key: hostId + "-opaque" });
    if (mode === "metadata") Object.assign(request, { voice: { profile: hostId, require_clone: false, fallback: "none" }, input: { text: document, format: "plain", source: hostId, text_hash: hostId } });
    if (mode === "invalid") Object.assign(request, { use: privacyText });
    connection.send(request); await tick();
    const refused = ["limit", "invalid", "pre-hello"].includes(mode);
    if (refused) c.assert(events("error").some(e => e.code === (mode === "limit" ? "INPUT_TOO_LONG" : mode === "pre-hello" ? "NOT_NEGOTIATED" : "INVALID_REQUEST")));
    else {
      const plan = events("plan")[0]; c.assert(Boolean(plan) && Array.isArray(plan.pieces));
      if (!markdown) {
        c.assert(obj(plan.display_document).text === document);
        c.assert(JSON.stringify(Array.isArray(plan.words) ? plan.words.map(w => obj(w).text) : []) === JSON.stringify(document.split(/\s+/)));
      }
      const count = Array.isArray(plan.pieces) ? plan.pieces.length : 0;
      if (mode === "conflict") connection.send(read(privacyText + " Extra.", { request_id: hostId + "-conflict" }));
      if (mode === "second-hello") connection.send(hello);
      if (mode === "unknown-control" || mode === "unknown-stop") connection.send({ protocol: "nl.engine/1", type: "control", command_id: hostId, session_id: "never-issued", op: "stop", args: { scope: "session", reason: "stop" } });
      const session = events("accepted")[0].session_id;
      if (mode === "queued") { connection.send(read(privacyText, { request_id: hostId + "-queued", idempotency_key: hostId + "-queued", start: { after_session: session } })); await tick(); }
      if (mode === "stop" || mode === "shutdown") {
        await wait(() => events("piece_ready").length === 1);
        for (const edge of ["spawned", "first_sample"]) connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: session, player_instance_id: "privacy-midway", control_epoch: 1, piece_index: 0, edge, t_mono_ms: c.clock.now() });
        if (mode === "stop") connection.send({ protocol: "nl.engine/1", type: "control", command_id: hostId, session_id: session, op: "stop", args: { scope: "session", reason: "stop" } });
        else void connection.shutdown(c.clock.now());
        await wait(() => events("outcome").length === 1);
        c.assert(obj(events("outcome")[0].playback).reason === (mode === "stop" ? "stop" : "shutdown"));
      } else if (mode === "failure") {
        await wait(() => events("outcome").length === 1); c.assert(events("error").some(e => e.code === "SYNTH_FAILED"));
      } else {
        await wait(() => events("piece_ready").length === count);
        if (mode === "release") {
          const lease_id = obj(events("piece_ready")[0].artifact).lease_id;
          for (let i = 0; i < 2; i++) { connection.send({ protocol: "nl.engine/1", type: "artifact_release", lease_id }); await tick(); }
          c.assert(events("error").some(e => e.code === "ARTIFACT_EXPIRED"));
        }
        await complete(String(request.request_id));
        if (mode === "queued" || mode === "second-read") {
          const id = hostId + (mode === "queued" ? "-queued" : "-second");
          if (mode === "second-read") {
            connection.send(read(privacyText, { request_id: id, idempotency_key: id }));
            await wait(() => events("outcome").length === 2);
            c.assert(events("error").some(e => e.code === "SYNTH_FAILED"));
          }
          if (mode === "queued") {
            await wait(() => events("piece_ready").length === count + 1);
            const queued = events("accepted").find(e => e.request_id === id);
            for (const edge of ["spawned", "first_sample"]) connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: queued?.session_id ?? "missing", player_instance_id: "privacy-player-0", control_epoch: 1, piece_index: 0, edge, t_mono_ms: c.clock.now() });
          }
          if (mode === "queued") { await wait(() => events("piece_ready").length === count * 2); await complete(id); }
        }
      }
    }
    let closed = false; void connection.shutdown(c.clock.now()).then(() => { closed = true; }, e => { error = e; });
    await wait(() => closed && ended); backend.assertDrained();
    const expected = mode === "conflict" ? "IDEMPOTENCY_CONFLICT" : mode === "unknown-stop" || mode === "unknown-control" ? "UNKNOWN_SESSION" : mode === "second-hello" ? "INVALID_REQUEST" : undefined;
    if (expected) c.assert(events("error").some(e => e.code === expected));
    for (const event of seen) c.assert(!hasReadText(outsideText(event)));
    for (const log of logs) c.assert(!hasReadText(log));
    c.assert(!hasReadText(logs.join("")));
  } finally { for (const restore of restores.reverse()) restore(); }
}
