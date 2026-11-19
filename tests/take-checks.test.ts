import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { firstWordOmitted, pitchRunaway, wordMismatches } from "../src/quality/take-checks.js";

const word = (word: string) => ({ word, start: 0, end: 0.2 });
test("first word: presence, omission, empty recognition, case and punctuation", () => {
  expect(firstWordOmitted("Hello, moon!", [word("HELLO!")]).omitted).toBe(false);
  expect(firstWordOmitted("Hello moon", [word("moon")]).omitted).toBe(true);
  expect(firstWordOmitted("Hello moon", []).omitted).toBe(true);
  expect(() => firstWordOmitted("", [])).toThrow();
});

test("opening tokens: skip symbols, bound search, join splits and equate numbers", () => {
  expect(firstWordOmitted('— … " Hello moon', [word("—"), word("HELLO")]).omitted).toBe(false);
  expect(firstWordOmitted("Hello moon", [word("a"), word("b"), word("Hello")]).omitted).toBe(false);
  expect(firstWordOmitted("Hello moon", [word("a"), word("b"), word("c"), word("Hello")]).omitted).toBe(true);
  expect(firstWordOmitted("Sun-light moon", [word("sun"), word("light")]).omitted).toBe(false);
  expect(firstWordOmitted("can't-stop moon", [word("can't"), word("stop")]).omitted).toBe(false);
  expect(firstWordOmitted("Three moons", [word("3")]).omitted).toBe(false);
  expect(firstWordOmitted("3 moons", [word("three")]).omitted).toBe(false);
  expect(firstWordOmitted("twenty five moons", [word("25")]).omitted).toBe(false);
  expect(firstWordOmitted("25 moons", [word("twenty"), word("five")]).omitted).toBe(false);
  expect(firstWordOmitted("three moons", [word("9")]).omitted).toBe(true);
});

test("YIN threshold keeps moderately noisy voiced frames", () => {
  let seed = 1;
  const samples = new Float32Array(8000);
  for (let i = 0; i < samples.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    samples[i] = 0.2 * Math.sin(2 * Math.PI * 180 * i / 8000) + 0.12 * (seed / 2 ** 32 * 2 - 1);
  }
  const result = pitchRunaway(samples, 8000, 300);
  expect(result.windows[0].voicedFrames).toBeGreaterThanOrEqual(10);
  expect(result.worstMedianHz).toBeCloseTo(181, 0);
});

test("pitch ignores the partial tail and windows with fewer than ten voiced frames", () => {
  const sr = 8000;
  const tail = new Float32Array(sr * 2.08);
  for (let i = 0; i < tail.length; i++) tail[i] = 0.2 * Math.sin(2 * Math.PI * (i < sr * 2 ? 180 : 400) * i / sr);
  const result = pitchRunaway(tail, sr, 300);
  expect(result.failed).toBe(false);
  expect(result.windows.length).toBe(2);
  const blip = new Float32Array(sr);
  for (let i = Math.ceil(sr * 0.501); i < sr * 0.561; i++) blip[i] = 0.2 * Math.sin(2 * Math.PI * 400 * i / sr);
  const short = pitchRunaway(blip, sr, 300);
  expect(short.failed).toBe(false);
  expect(short.windows[0].voicedFrames).toBeLessThan(10);
  expect(short.windows[0].medianHz).toBeNull();
  expect(short.worstMedianHz).toBeNull();
  const tenFrames = new Float32Array(sr);
  for (let i = sr * 0.5; i < sr * 0.56; i++) tenFrames[i] = 0.2 * Math.sin(2 * Math.PI * 400 * i / sr);
  const judged = pitchRunaway(tenFrames, sr, 300);
  expect(judged.windows[0].voicedFrames).toBe(10);
  expect(judged.failed).toBe(true);
});

/** `decay` lets the tone die away over 0.12 s after 3.5 s, like a finished take; without it the tone stops at full level. */
function tone(runaway: boolean, decay = false) {
  const sr = 24000, samples = new Float32Array(sr * 4);
  let phase = 0;
  for (let i = sr / 2; i < sr * 3.5 + (decay ? sr * 0.12 : 0); i++) {
    const t = i / sr;
    const hz = runaway ? t < 1.5 ? 180 + 220 * (t - 0.5) : t < 3 ? 400 : 180 : 180;
    phase += 2 * Math.PI * hz / sr;
    samples[i] = 0.2 * Math.sin(phase) * (t < 3.5 ? 1 : Math.exp(-(t - 3.5) / 0.015));
  }
  return samples;
}
test("24 kHz tone passes, sweep with 1.5 s at high pitch fails", () => {
  const good = pitchRunaway(tone(false), 24000, 300);
  expect(good.failed).toBe(false);
  expect(good.worstMedianHz).toBeCloseTo(180, 0);
  const bad = pitchRunaway(tone(true), 24000, 300);
  expect(bad.failed).toBe(true);
  expect(bad.worstMedianHz).toBeCloseTo(400, 0);
  expect(bad.overCeiling.length).toBeGreaterThan(0);
  expect(pitchRunaway(tone(true), 24000, 420).failed).toBe(false);
  expect(pitchRunaway(new Float32Array(24000), 24000, 300).worstMedianHz).toBeNull();
  expect(() => pitchRunaway(tone(false), 24000, NaN)).toThrow();
});
test("real CLI emits JSON and exit codes on synthetic WAVs", () => {
  const dir = "docs.local/take-checks-test";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/sent`, "Hello moon");
  writeFileSync(`${dir}/words.json`, JSON.stringify([word("Hello"), word("moon")]));
  for (const [high, omitted, substituted] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) {
    writeFileSync(`${dir}/words.json`, JSON.stringify(omitted ? [word("moon")] : [word("Hello"), word(substituted ? "sun" : "moon")]));
    // Decayed, so a take-end cut is not what fails it (tests/check-take-end.test.ts covers that).
    const samples = tone(high, true), pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2));
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    writeFileSync(`${dir}/tone.wav`, Buffer.concat([header, pcm]));
    const run = Bun.spawnSync([process.execPath, "src/cli.ts", "check-take", `${dir}/tone.wav`, "--sent", `${dir}/sent`, "--words", `${dir}/words.json`, "--voice", "synthetic", "--pitch-ceiling", "300"]);
    expect(run.exitCode).toBe(high || omitted || substituted ? 1 : 0);
    expect(JSON.parse(run.stdout.toString()).pass).toBe(!high && !omitted && !substituted);
  }
  const base = [process.execPath, "src/cli.ts", "check-take", `${dir}/tone.wav`, "--sent", `${dir}/sent`, "--words", `${dir}/words.json`, "--voice", "synthetic"];
  expect(Bun.spawnSync(base).exitCode).toBe(2);
  expect(Bun.spawnSync([...base, "--pitch-ceiling", "0"]).exitCode).toBe(2);
  expect(Bun.spawnSync([...base, "--pitch-ceiling", "300"], { env: { ...process.env, PATH: "" } }).exitCode).toBe(2);
  const unreadable = [...base]; unreadable[3] = `${dir}/missing.wav`;
  expect(Bun.spawnSync([...unreadable, "--pitch-ceiling", "300"]).exitCode).toBe(2);

});

const recognised = (text: string) => text.split(" ").map((word, index) => ({ word, start: index * 0.3, end: (index + 1) * 0.3 }));
for (const [contracted, expansions] of [
  ["Here's", ["Here is", "Here has"]], ["What's", ["What is", "What has"]],
  ["Where's", ["Where is", "Where has"]], ["How's", ["How is", "How has"]],
  ["Who's", ["Who is", "Who has"]], ["He's", ["He is", "He has"]],
  ["She's", ["She is", "She has"]], ["It's", ["It is", "It has"]],
  ["That's", ["That is", "That has"]], ["There's", ["There is", "There has"]],
  ["He'll", ["He will"]], ["She'll", ["She will"]], ["It'll", ["It will"]],
  ["That'll", ["That will"]], ["There'll", ["There will"]], ["Who'll", ["Who will"]],
  ["I'd", ["I would", "I had"]], ["You'd", ["You would", "You had"]],
  ["He'd", ["He would", "He had"]], ["She'd", ["She would", "She had"]],
  ["It'd", ["It would", "It had"]], ["We'd", ["We would", "We had"]],
  ["They'd", ["They would", "They had"]], ["That'd", ["That would", "That had"]],
  ["There'd", ["There would", "There had"]], ["Who'd", ["Who would", "Who had"]],
  ["They're", ["They are"]], ["We're", ["We are"]], ["You're", ["You are"]],
  ["There're", ["There are"]],
  ["We've", ["We have"]], ["They've", ["They have"]], ["You'll", ["You will"]],
  ["Couldn't", ["Could not"]], ["Wouldn't", ["Would not"]], ["Shouldn't", ["Should not"]],
  ["Let's", ["Let us"]],
] satisfies [string, string[]][]) {
  for (const expanded of expansions) {
    test(`contraction equivalence: ${contracted} / ${expanded}`, () => {
      for (const spelling of [contracted, contracted.replace("'", "’")]) {
        expect(wordMismatches(`${expanded} the plan`, recognised(`${spelling} the plan`)).pass).toBe(true);
        expect(wordMismatches(`${spelling} the plan`, recognised(`${expanded} the plan`)).pass).toBe(true);
        expect(wordMismatches(`${expanded} the plan`, recognised(`${spelling} the plan`), { tolerance: false }).pass).toBe(false);
      }
    });
  }
}
for (const [sent, heard] of [
  ["Kowalski's plan", "Kowalsky's plan"],
  ["Johnson's plan", "Jonson's plan"],
  ["Thompson's Ferrari", "Thomson's Ferrari"],
]) {
  test(`possessive spelling allowance: ${sent} / ${heard}`, () => {
    for (const apostrophe of ["'", "’"]) {
      const expected = sent.replace("'", apostrophe), actual = heard.replace("'", apostrophe);
      expect(wordMismatches(expected, recognised(actual)).pass).toBe(true);
      expect(wordMismatches(actual, recognised(expected)).pass).toBe(true);
      expect(wordMismatches(expected, recognised(actual), { tolerance: false }).pass).toBe(false);
    }
  });
}
test("contractions preserve different subjects, adjacent words and written apostrophes", () => {
  for (const [sent, heard] of [
    ["Here is", "There's"], ["Here's the plan", "There is the plan"],
    ["Here is the clear plan", "Here's the plan"], ["Here's the clear plan", "Here is the plan"],
    ["Here is the plan", "Heres the plan"], ["Let us go", "Lets go"],
    ["He will go", "Hell go"], ["She has finished", "She finished"],
    ["He would go", "He will go"], ["He'll go", "She'll go"], ["He'd go", "She'd go"],
    ["He'll go", "Hell go"], ["She'll go", "Shell go"], ["She'd go", "Shed go"],
    ["We'd go", "Wed go"], ["I'd go", "ID go"],
    ["Here is the plan", "Here's the extra plan"],
  ]) expect(wordMismatches(sent, recognised(heard)).pass).toBe(false);
});

for (const [name, sent, heard, kind, index] of [
  ["missing first", "Hello silver moon", "silver moon", "deletion", 0],
  ["missing middle", "Hello silver moon", "Hello moon", "deletion", 1],
  ["extra leading", "Hello moon", "Oh Hello moon", "insertion", 0],
  ["repeated word", "Hello silver moon", "Hello silver silver moon", "insertion", 1],
  ["short substitution", "Put it here", "Put it there", "substitution", 2],
] as const) {
  test(`whole take rejects ${name}`, () => {
    const result = wordMismatches(sent, recognised(heard));
    expect(result.pass).toBe(false);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].kind).toBe(kind);
    if (kind !== "insertion") expect(result.edits[0].sentIndex).toBe(index);
    if (kind === "deletion") expect(result.edits[0].start).toBeNull();
    else expect(result.edits[0].end).toBeGreaterThan(result.edits[0].start!);
  });
}
for (const [sent, heard] of [
  ["Hello, moon!", "HELLO moon"],
  ["25 moons", "twenty five moons"],
  ["twenty five moons", "25 moons"],
  ["BrainBar is ready", "brain bar is ready"],
  ["brain bar is ready", "BrainBar is ready"],
  ["We don't stop", "We do not stop"],
  ["We do not stop", "We don't stop"],
  ["A colourful lantern", "A colorful lantern"],
]) {
  test(`whole take tolerates ${sent} / ${heard}`, () => {
    expect(wordMismatches(sent, recognised(heard)).pass).toBe(true);
  });
}
test("whole take fails empty recognition and does not sum arbitrary number words", () => {
  expect(wordMismatches("Hello moon", []).pass).toBe(false);
  expect(wordMismatches("3 moons", recognised("one two moons")).pass).toBe(false);
  expect(wordMismatches("Well done", recognised("we will done")).pass).toBe(false);
  expect(wordMismatches("Hello moon", recognised("Hello moon moon")).pass).toBe(false);
  expect(wordMismatches("BrainBar", recognised("brain bar"), { tolerance: false }).pass).toBe(false);
});

test("word-check settings retain evidence for ignored substitutions", () => {
  const commonWords = new Set(["a", "the", "moon", "sun", "cat"]);
  const options = { commonWords };
  expect(wordMismatches("HyperBar", recognised("HiperCar"), { ...options, setting: "a" }).pass).toBe(false);
  expect(wordMismatches("HyperBar", recognised("HiperCar"), { ...options, setting: "b" }).pass).toBe(true);
  expect(wordMismatches("a cat", recognised("uh cat"), { ...options, setting: "b" }).pass).toBe(false);
  const relaxed = wordMismatches("a cat", recognised("uh cat"), { ...options, setting: "c" });
  expect(relaxed.pass).toBe(true);
  expect(relaxed.ignoredEdits).toHaveLength(1);
  expect(wordMismatches("moon", recognised("sun"), { ...options, setting: "c" }).pass).toBe(false);
  expect(wordMismatches("moon", recognised("sun"), { setting: "d" }).pass).toBe(true);
  expect(wordMismatches("a moon", recognised("moon"), { setting: "d" }).pass).toBe(false);
  expect(() => wordMismatches("a", recognised("a"), { setting: "b" })).toThrow("dictionary");
});
