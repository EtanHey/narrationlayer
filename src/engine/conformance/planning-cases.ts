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
async function read(c: CaseContext, units: Unit[], expected = units, format: "plain" | "markdown" = "markdown") {
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
  connection.send({ protocol: "nl.engine/1", type: "narrate", request_id: "planning-read", idempotency_key: "planning-key", use: "read", input: { text, format }, voice: { profile: "synthetic", require_clone: false, fallback: "none" }, delivery: "pieces", lookahead: 2 });
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
  const welcome = seen.find(e => e.type === "welcome");
  const limit = welcome?.engines.find(e => e.family === plan.engine.family)?.max_chars;
  c.assert(typeof limit === "number" && limit > 0);
  return { plan, pieces, ranges, limit: limit ?? 0 };
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
// Independent document scan: fit whitespace boundaries, then prefer the last valid mark.
function cuts(text: string, limit: number): string[] {
  const result: string[] = [];
  while (text.length > limit) {
    const valid = [...text.matchAll(/\s+/gu)].filter(m => m.index <= limit && count(text.slice(0, m.index)) >= 3 && count(text.slice(m.index + m[0].length)) >= 3);
    const marked = valid.filter(m => /[,;:—―–]$|\s-$/u.test(text.slice(0, m.index)));
    const cut = (marked.length ? marked : valid).at(-1);
    if (!cut) throw new Error("fixture has no valid cut");
    result.push(text.slice(0, cut.index)); text = text.slice(cut.index + cut[0].length);
  }
  return [...result, text];
}
const w = (n: number) => Array(n).fill("lantern").join(" ");
const over = [
  `${w(13)} amber — tail words.`, `${w(5)}, ${w(8)} amber — tail words.`,
  `${w(6)}: ${w(6)}, ${w(6)} and ${w(4)}.`, `${w(22)}.`,
  `${w(12)} well-made lamp—${w(6)}.`, `Lantern, ${w(20)}.`,
  `${w(5)}, ${w(7)}; ${w(6)}: ${w(9)}, ${w(8)} — ${w(7)}, ${w(6)}.`,
];
const dashRows = ["first- and second-rate lanterns glow.", "pages 3- 4 lantern lantern lantern.",
  "amber - tail words lantern lantern.", "amber— tail words lantern lantern.",
  "amber ― tail words lantern lantern.", "amber – tail words lantern lantern.", "amber —tail words lantern lantern."]
  .map(tail => `${w(12)} ${tail}`);
const middle = `Lantern ${w(5)}, ${w(6)}, ${w(6)} and ${w(4)}.`;
const surroundings = (text: string) => [unit("sentence", "Copper boats drift slowly."), unit("sentence", text), unit("sentence", "Violet cranes glide home.")];
function boundaries(c: CaseContext, d: Awaited<ReturnType<typeof read>>) {
  for (const u of d.ranges) {
    const actual = d.pieces.filter(p => d.plan.pieces[p.index].word_start >= u.start && d.plan.pieces[p.index].word_end <= u.end).map(p => p.spoken_text);
    const expected = u.kind === "sentence" ? cuts(u.text, d.limit) : [u.text];
    c.assert(JSON.stringify(actual.map(equivalent)) === JSON.stringify(expected.map(equivalent)));
    if (u.kind === "sentence") for (const text of actual) c.assert(text.length <= d.limit);
    // Exact source slices prove that no boundary is inside a word.
    c.assert(equivalent(actual.join(" ")) === equivalent(u.text));
  }
}
export const planningCases: Record<string, Case> = {
  "PLAN-D4": async c => {
    for (const text of [...over, ...dashRows]) {
      const d = await read(c, [unit("sentence", text)], undefined, "plain");
      c.assert(text.length > d.limit); boundaries(c, d);
    }
    for (const text of [`${w(15)}.`, `Lantern ${w(5)}, ${w(6)}.`]) boundaries(c, await read(c, [unit("sentence", text)], undefined, "plain"));
    boundaries(c, await read(c, surroundings(middle), undefined, "plain"));
    boundaries(c, await read(c, [heading("Harbour notes"), ...surroundings(middle), unit("item", "Carry the copper lanterns home")]));
  },
  "PLAN-02": async c => {
    for (const text of over) {
      const d = await read(c, [unit("sentence", text)], undefined, "plain");
      const control = await read(c, [unit("sentence", "Copper boats drift.")], undefined, "plain");
      const expected = cuts(text, d.limit);
      c.assert(d.pieces.length === expected.length);
      for (const [i, p] of d.plan.pieces.entries()) {
        c.assert(p.segments[0].pause_after_ms === (i === d.plan.pieces.length - 1 ? control.plan.pieces[0].segments[0].pause_after_ms : 0));
        if (d.pieces[i].spoken_text.endsWith(":")) c.assert(d.pieces[i].spoken_text === expected[i]);
      }
    }
    for (const format of ["plain", "markdown"] as const) {
      const d = await read(c, surroundings(middle), undefined, format);
      const control = await read(c, surroundings(`Lantern ${w(5)}, ${w(6)}.`), undefined, format);
      const u = d.ranges[1], inside = d.plan.pieces.filter(p => p.word_start >= u.start && p.word_end <= u.end);
      c.assert(inside.length === cuts(middle, d.limit).length);
      c.assert(control.plan.pieces[1].segments[0].pause_after_ms > 0);
      for (const p of inside.slice(0, -1)) c.assert(p.segments[0].pause_after_ms === 0);
      c.assert(inside.at(-1)?.segments[0].pause_after_ms === control.plan.pieces[1].segments[0].pause_after_ms);
    }
    const d = await read(c, [unit("sentence", over[2])], undefined, "plain");
    const expected = cuts(over[2], d.limit);
    c.assert(expected[0].endsWith(","));
    c.assert(d.pieces[0].spoken_text === expected[0]);
  },
  "PLAN-D5": async c => {
    minimum(c, await read(c, minimumUnits("Lantern")), 3);
    for (const text of [over[0], over[1], over[5]]) minimum(c, await read(c, [unit("sentence", text)], undefined, "plain"), 3);
  },
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
      if (i === 0) { units.push(unit("sentence", middle)); projected.push(unit("sentence", middle)); }
      const d = await read(c, units, projected);
      for (const u of d.ranges) {
        if (u.kind !== "sentence" || u.text.length <= d.limit) c.assert(d.plan.pieces.filter(p => p.word_start === u.start && p.word_end === u.end).length === 1);
      }
      boundaries(c, d);
      c.assert(d.pieces.length === projected.reduce((n, u) => n + (u.kind === "sentence" ? cuts(u.text, d.limit).length : 1), 0));
    }
  },
  "PAUSE-PL-01": async c => {
    const plain = await read(c, [unit("sentence", "Copper boats drift."), unit("sentence", "Violet cranes glide.")], undefined, "plain");
    c.assert(plain.plan.pieces[0].segments[0].pause_after_ms === 550 && plain.plan.pieces[1].segments[0].pause_after_ms === 0);
    const d = await read(c, [heading("Meadow"), unit("item", "Gather the pears"), unit("item", "Carry all the green baskets home"), unit("sentence", "Quiet boats return."), unit("sentence", "Golden birds settle.")]);
    c.assert(d.plan.pieces.length === 5);
    d.plan.pieces.forEach((p, i) => c.assert(!p.raw && p.segments.length === 1 && p.segments[0].pause_in === "this_piece_end" && p.segments[0].pause_after_ms === [900, 450, 700, 550, 0][i]));
  },
};
