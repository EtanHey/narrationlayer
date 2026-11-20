import { expect, test } from "bun:test";
import { wordMismatches } from "../src/quality/take-checks.js";
import * as equivalence from "../src/quality/transcription-equivalence.js";

const words = (text: string) => text.split(" ").map((word, i) => ({ word, start: i, end: i + 1 }));
const check = (sent: string, heard: string) => wordMismatches(sent, words(heard), { setting: "a" }).pass;

// Whisper writes an exact homophone for a word the voice said right (P3.4: "cache" as "cash"
// failed 21 of 24 attempts). Each pair failed takes already on disk whose other words were right.
const homophones: [string, string][] = [
  ["The cache keeps every take.", "The cash keeps every take."],
  ["The queues are empty.", "The cues are empty."],
  ["The queue is empty.", "The cue is empty."],
  ["The job queued again.", "The job cued again."],
  ["Split the pane now.", "Split the pain now."],
  ["Close both panes now.", "Close both pains now."],
  ["A usage brake is gone.", "A usage break is gone."],
  ["The agent waits here.", "The agent weights here."],
  ["Then wait for the push.", "Then weight for the push."],
  ["The disk is full.", "The disc is full."],
  ["Ask the council first.", "Ask the counsel first."],
  ["Plain prose wins.", "Plain pros wins."],
  ["The miner runs nightly.", "The minor runs nightly."],
  ["The dialogs open.", "The dialogues open."],
  ["Hey, look here.", "Hay, look here."],
];
for (const [sent, heard] of homophones) {
  test(`exact homophone passes: ${sent} / ${heard}`, () => {
    expect(check(sent, heard)).toBe(true);
    expect(check(heard, sent)).toBe(true);
    expect(wordMismatches(sent, words(heard), { tolerance: false }).pass).toBe(false);
  });
}

// The defect table's marked slips (P3.0 sections 9-11) that fail on master must still fail.
// The voice said a different sound; the heard spelling is the slip as the listener wrote it.
const markedSlips: [string, string][] = [
  ["Where does each thing I settled by voice stand?", "Where does each thing I settled by voice stan?"],
  ["Send it to this address.", "Send it to this addre."],
  ["Read it aloud.", "Read it alod."],
  ["The video had sound and text.", "The video had sound ant text."],
  ["It made the call.", "It may the call."],
  ["Use shadcn here.", "Use shadchen here."],
  ["Deleting old branches.", "Dlisting old branches."],
  ["Back from the queue.", "Back fro the queue."],
  ["Turn it off now.", "Turn it aw now."],
  ["It restyles the dialog.", "It rest the dialog."],
  ["The time was wasted work.", "The time was wasted wo."],
  ["The expected result.", "The expect result."],
  ["The guard stays.", "The gar stays."],
];
for (const [sent, heard] of markedSlips) {
  test(`marked slip still fails: ${sent} / ${heard}`, () => {
    expect(check(sent, heard)).toBe(false);
  });
}

// Near in spelling or in sound, but not the same sound: these must fail.
const differentSound: [string, string][] = [
  ["The cache keeps every take.", "The catch keeps every take."],
  ["The cache keeps every take.", "The cast keeps every take."],
  ["The caches keep every take.", "The cash keep every take."],
  ["The cache keeps every take.", "The cashes keep every take."],
  ["Pull the branch.", "Poll the branch."],
  ["The facts are in.", "The fax are in."],
  ["Split the pane now.", "Split the paint now."],
  ["Write the receipt first.", "Wrote the receipt first."],
  ["The variants differ.", "The variance differ."],
  ["Put the ladder here.", "Put the latter here."],
  // Heteronyms stay out: "read" can be "reed", and "route" can be "rowt".
  ["I read it.", "I red it."],
  ["Take the route home.", "Take the root home."],
  // Number words keep #149's rule: no allowance, homophone or spelling.
  ["Two takes passed.", "To takes passed."],
  ["One take passed.", "Won take passed."],
  // A written apostrophe keeps #146's rule.
  ["It's done.", "Its done."],
  // Same sound but not listed: #143's review ruled these fail, and no measured take needs them.
  ["It is right there.", "It is write there."],
  ["They knew it.", "They new it."],
  ["A grey panel.", "A gray panel."],
  // Groups never cross: cache and queue are different sounds.
  ["The cache is empty.", "The cue is empty."],
];
for (const [sent, heard] of differentSound) {
  test(`different sound fails: ${sent} / ${heard}`, () => {
    expect(check(sent, heard)).toBe(false);
    expect(check(heard, sent)).toBe(false);
  });
}

test("homophones match one word for one word, never inside a joined compound", () => {
  // Controls that pass on master keep passing.
  expect(check("Take a painkiller.", "Take a pain killer.")).toBe(true);
  expect(check("The cache keeps every take.", "the cache keeps every take")).toBe(true);
  // A homophone does not join with a neighbour.
  expect(check("The cashier waits.", "The cache ier waits.")).toBe(false);
});

test("the homophone list is reviewed: no number words, no apostrophes, no word in two groups", () => {
  // Read through the namespace so this file also runs (and fails) on master, where the list is absent.
  const groups = (equivalence as { TRANSCRIPTION_HOMOPHONES?: readonly (readonly string[])[] }).TRANSCRIPTION_HOMOPHONES;
  expect(groups?.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const group of groups ?? []) {
    expect(group.length).toBeGreaterThanOrEqual(2);
    for (const word of group) {
      expect(word).toMatch(/^[a-z]+$/);
      expect(equivalence.isTranscriptionNumberSpan([word])).toBe(false);
      expect(seen.has(word)).toBe(false);
      seen.add(word);
    }
  }
});
