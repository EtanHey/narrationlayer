import type { Case, CaseContext } from "./runner";
import type { Event } from "../messages/messages";
import { parseEvent } from "../messages/parser";
import { pcmAudio, ScriptedBackend } from "./fake-backend";
import { ScriptedPlayer, ScriptedSpawn } from "./fake-player";
import { ScriptedHost } from "./host-stub";
import { assertBackendCalls, hello } from "./engine-cases";

type Unit = { kind: "heading" | "item" | "sentence"; text: string };
const unit = (kind: Unit["kind"], text: string): Unit => ({ kind, text });
const words = (s: string) => s.trim().split(/\s+/u);
const count = (s: string) => words(s).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
const equivalent = (s: string) => s.replace(/[.:]$/u, "");
async function bounded(c: CaseContext, promise: Promise<unknown>) {
  let done = false, error: unknown;
  void promise.then(() => { done = true; }, e => { done = true; error = e; });
  for (let i = 0; i < 8 && !done; i++) { await c.clock.advance(1); for (let j = 0; j < 128; j++) await Promise.resolve(); }
  c.assert(done); if (error) throw error;
}
async function read(c: CaseContext, units: Unit[], expected = units) {
  const backend = new ScriptedBackend(c.clock), spawn = new ScriptedSpawn(c.clock), player = new ScriptedPlayer(c.clock, spawn);
  const synthesize = backend.synthesizeRequest.bind(backend);
  backend.synthesizeRequest = (request, signal) => {
    backend.script([{ latency_ms: 1, late_after_cancel: false, result: { kind: "audio", ...pcmAudio(100) } }]);
    return synthesize(request, signal);
  };
  const connection = c.binding.create({ clock: c.clock, ports: { backend, spawn, player, host: new ScriptedHost(c.clock) }, store: new Map(), hash_key: new Uint8Array(32), audible: false });
  const seen: Event[] = [];
  const collect = (async () => { for await (const event of connection.events) { const parsed = parseEvent(event); c.assert(parsed.ok); if (parsed.ok && parsed.value) seen.push(parsed.value); } })().catch(() => { c.failed = true; });
  const text = units.map(u => u.kind === "heading" ? `# ${u.text}` : u.kind === "item" ? `- ${u.text}` : u.text).join("\n");
  connection.send(hello);
  connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: "planning-read", idempotency_key: "planning-key", use: "read", input: { text, format: "markdown" }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 2 });
  let delivered = 0;
  for (let tick = 0; tick < 128 && !seen.some(e => e.type === "outcome"); tick++) {
    await c.clock.advance(1); for (let j = 0; j < 128; j++) await Promise.resolve();
    for (const p of seen.filter(e => e.type === "piece_ready").slice(delivered)) {
      delivered++;
      for (const edge of ["spawned", "first_sample", "first_audible", "last_sample", "exited"]) connection.send({ protocol: "nl.engine/1", type: "player_feedback", session_id: p.session_id, control_epoch: p.index + 1, player_instance_id: `planning-${p.index}`, piece_index: p.index, edge, t_mono_ms: c.clock.now(), source: "player_reported", ...(edge === "exited" ? { exit: { status: "completed", stopped_at_ms: p.start_ms + p.duration_ms } } : {}) });
    }
  }
  await bounded(c, connection.shutdown(c.clock.now())); await bounded(c, collect);
  backend.assertDrained(); spawn.assertDrained(); player.assertDrained();
  const accepted = seen.filter(e => e.type === "accepted"); c.assert(accepted.length === 1);
  const own = seen.filter(e => "session_id" in e && e.session_id === accepted[0].session_id);
  const plans = own.filter(e => e.type === "plan"), pieces = own.filter(e => e.type === "piece_ready"), outcomes = own.filter(e => e.type === "outcome");
  c.assert(plans.length === 1 && outcomes.length === 1 && outcomes[0].generation.status === "committed" && outcomes[0].playback.reason === "completed");
  c.assert(!seen.some(e => e.type === "error"));
  const plan = plans[0]; c.assert(plan.pieces.length > 0 && pieces.length === plan.pieces.length);
  c.assert(plan.words.length === expected.reduce((n, u) => n + words(u.text).length, 0));
  // Source units supply the expected word ownership. No planner/tokenizer import.
  let cursor = 0;
  const ranges = expected.map(u => { const start = cursor; cursor += words(u.text).length;
    c.assert(equivalent(plan.words.slice(start, cursor).map(w => w.text).join(" ")) === equivalent(u.text));
    return { ...u, start, end: cursor }; });
  plan.pieces.forEach((p, i) => {
    const ready = pieces[i];
    c.assert(p.index === i && p.word_start === (i ? plan.pieces[i - 1].word_end : 0) && p.word_end > p.word_start && p.word_end <= cursor);
    c.assert(p.segments.length === 1 && p.segments[0].word_start === p.word_start && p.segments[0].word_end === p.word_end);
    c.assert(ready.index === i && ready.piece_id === p.piece_id && ready.attempt_id === plan.attempt_id && own.indexOf(plan) < own.indexOf(ready));
    const joined = plan.words.slice(p.word_start, p.word_end).map(w => w.text).join(" ");
    // Projection may close a heading/item. All other bytes come from plan.words.
    const spoken = p.segments[0].kind === "heading" && joined.endsWith(":") ? joined.slice(0, -1) + "." : joined;
    c.assert(ready.spoken_text === spoken || (p.segments[0].kind !== "sentence" && !/[.!?]$/.test(spoken) && ready.spoken_text === spoken + "."));
    const u = ranges.find(u => p.word_start >= u.start && p.word_end <= u.end); c.assert(!!u && p.segments[0].kind === u.kind);
  });
  c.assert(plan.pieces.at(-1)?.word_end === cursor);
  assertBackendCalls(c, seen, backend.calls, accepted[0].session_id, pieces);
  c.assert(own.at(-1)?.type === "outcome");
  return { plan, pieces, ranges };
}
const heading = (text: string) => unit("heading", text);
function minimum(c: CaseContext, data: Awaited<ReturnType<typeof read>>, floor: number) {
  for (const p of data.plan.pieces) {
    const u = data.ranges.find(u => p.word_start >= u.start && p.word_end <= u.end); c.assert(!!u);
    const n = count(data.plan.words.slice(p.word_start, p.word_end).map(w => w.text).join(" "));
    c.assert(n >= floor || (!!u && count(u.text) < floor && p.word_start === u.start && p.word_end === u.end));
  }
}
const minimumUnits = (name: string) => [heading(name), unit("item", "Acorns"), unit("item", "Gather all the ripe pears"), unit("sentence", "Gentle orchard keepers carry green baskets home."), unit("sentence", "Golden boats return before dusk."), unit("sentence", "Birds settle.")];
export const planningCases: Record<string, Case> = {
  "PLAN-D5": async c => { const d = await read(c, minimumUnits("Lantern")); minimum(c, d, 3); },
  "PLAN-01": async c => { const d = await read(c, minimumUnits("Maple")); minimum(c, d, 2);
    for (const u of d.ranges.slice(0, 2)) c.assert(d.plan.pieces.filter(p => p.word_start === u.start && p.word_end === u.end).length === 1);
  },
  "PLAN-03": async c => {
    const source = ["Harvest", "Count the baskets twice", "Stack the empty crates beside the barn.", "Before the first frost, walk every row of the old orchard with a ladder and a lantern, pick the pears that give under a thumb, leave the hard ones for another week, and carry the ripe ones in.", "When the wagons come back from the mill in the evening, the miller counts the sacks aloud, and the children chalk each number on the barn door.", "Nobody goes home until every last sack is safe under the roof, because rain on fresh flour ruins one whole week of work."];
    c.assert(JSON.stringify(source.map(s => s.length)) === JSON.stringify([7, 23, 39, 192, 143, 120]));
    const fixtures = [[heading(source[0]), ...[...source.slice(1, 4), source.slice(4).join(" ")].map(s => unit("item", s))],
      [heading("Gardener"), ...["Plant three seeds", "Water the small seedlings each morning", "Keep the young plants beside the wide window throughout the cool afternoon", "Care label: water the roots and keep the leaves dry", "Use `garden_check` to count the green shoots", "Read the [planting guide](https://example.invalid/guide) for the next steps", "Visit https://example.invalid/garden for the planting guide"].map(s => unit("item", s)), unit("sentence", "Silver birds cross the meadow."), unit("sentence", "Quiet boats return before dusk.")]];
    for (const [i, units] of fixtures.entries()) {
      // Explicit projection spellings keep markup/URL normalization separate from boundary assertions.
      const projected = units.map(u => ({ ...u, text: u.text.replace(/`/g, "").replace(/\[planting guide\]\(https:\/\/example.invalid\/guide\)/g, "planting guide").replace("https://example.invalid/garden", "link") }));
      const d = await read(c, units, projected);
      for (const u of d.ranges) {
        c.assert(d.plan.pieces.filter(p => p.word_start === u.start && p.word_end === u.end).length === 1);
      }
      if (i === 0) c.assert(d.pieces.length === 5);
    }
  },
  "PAUSE-PL-01": async c => {
    const d = await read(c, [heading("Meadow"), unit("item", "Gather the pears"), unit("item", "Carry all the green baskets home"), unit("sentence", "Quiet boats return."), unit("sentence", "Golden birds settle.")]);
    c.assert(d.plan.pieces.length === 5);
    d.plan.pieces.forEach((p, i) => c.assert(!p.raw && p.segments.length === 1 && p.segments[0].pause_in === "this_piece_end" && p.segments[0].pause_after_ms === [900, 450, 700, 550, 0][i]));
  },
};
