import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { firstWordOmitted, pitchRunaway } from "../src/quality/take-checks.js";

const word = (word: string) => ({ word, start: 0, end: 0.2 });
test("first word: presence, omission, empty recognition, case and punctuation", () => {
  expect(firstWordOmitted("Hello, moon!", [word("HELLO!")]).omitted).toBe(false);
  expect(firstWordOmitted("Hello moon", [word("moon")]).omitted).toBe(true);
  expect(firstWordOmitted("Hello moon", []).omitted).toBe(true);
  expect(() => firstWordOmitted("", [])).toThrow();
});
function tone(runaway: boolean) {
  const sr = 24000, samples = new Float32Array(sr * 4);
  let phase = 0;
  for (let i = sr / 2; i < sr * 3.5; i++) {
    const t = i / sr;
    const hz = runaway ? t < 1.5 ? 180 + 220 * (t - 0.5) : t < 3 ? 400 : 180 : 180;
    phase += 2 * Math.PI * hz / sr;
    samples[i] = 0.2 * Math.sin(phase);
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
  for (const [high, omitted] of [[false, false], [true, false], [false, true]]) {
    writeFileSync(`${dir}/words.json`, JSON.stringify(omitted ? [word("moon")] : [word("Hello"), word("moon")]));
    const samples = tone(high), pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => pcm.writeInt16LE(Math.round(v * 32767), i * 2));
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    writeFileSync(`${dir}/tone.wav`, Buffer.concat([header, pcm]));
    const run = Bun.spawnSync([process.execPath, "src/cli.ts", "check-take", `${dir}/tone.wav`, "--sent", `${dir}/sent`, "--words", `${dir}/words.json`, "--voice", "synthetic", "--pitch-ceiling", "300"]);
    expect(run.exitCode).toBe(high || omitted ? 1 : 0);
    expect(JSON.parse(run.stdout.toString()).pass).toBe(!high && !omitted);
  }
});
