import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSilenceDetectOutput } from "../src/audio.js";
import { renderSegment } from "../src/pipelines/job-render/index.js";
import { parseArgs, runGate } from "../bin/narration-gate.js";

async function temporary<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "narration-mutation-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("mutation 5: paired ffmpeg silence spans survive parsing", () => {
  expect(parseSilenceDetectOutput([
    "[silencedetect] silence_end: 0.5 | silence_duration: 0.5",
    "[silencedetect] silence_start: 1.2",
    "[silencedetect] silence_end: 2.7 | silence_duration: 1.5",
    "[silencedetect] silence_end: 3 | silence_duration: 0.3",
    "[silencedetect] silence_start: 4",
    "[silencedetect] silence_end: 4.6 | silence_duration: 0.6",
    "[silencedetect] silence_start: 6",
  ].join("\n"))).toEqual([
    { start: 1.2, end: 2.7, duration: 1.5 },
    { start: 4, end: 4.6, duration: 0.6 },
  ]);
});

for (const seconds of [44, 46, 60]) {
test(`mutation 12: default absolute cap at ${seconds} seconds`, async () => {
  await temporary(async (root) => {
    let assembled = false;
    const rendering = renderSegment("segment", { title: "Synthetic", script: "A short synthetic sentence." }, {
      artifactsDir: path.join(root, "artifacts"), dataDir: root,
      jobId: "job", voiceProfile: "synthetic",
      fetch: async () => new Response(JSON.stringify({
        audio_b64: Buffer.from("synthetic audio").toString("base64"),
        audio_duration_ms: seconds * 1000,
      })),
    }, {
      daemon_url: "http://unused.invalid", auth_token: "synthetic",
      reference_clip: path.join(root, "reference.wav"), reference_text: "Synthetic reference.",
      pause_strategy: "punctuation", trim_silence: false, max_chunk_retries: 0,
      max_chunk_seconds_per_word: 30,
      audio_duration_probe: async () => seconds,
      audio_assembler: async ({ outputPath }) => {
        assembled = true;
        await Bun.write(outputPath, "assembled");
      },
    });
    if (seconds > 45) await expect(rendering).rejects.toThrow("runaway generated chunk");
    else expect((await rendering).status).toBe("rendered");
    if (seconds > 45) expect(assembled).toBe(false);
  });
});

}

async function cli(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "narrationlayer", ...args], {
    env: { ...process.env, NARRATIONLAYER_DATA_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`CLI exit ${code}: ${err}`);
  return out;
}

test("mutation 25: watch polls a rendered job and reports terminal status", async () => {
  await temporary(async (root) => {
    const input = path.join(root, "input.json");
    await Bun.write(input, JSON.stringify({ voice_profile: "neutral-reader", renderer: "fake",
      segments: [{ id: "synthetic", title: "Synthetic", script: "A synthetic narration." }] }));
    const output = await cli(root, ["create-job", input]);
    const id = output.match(/Job ID:\s*([A-Za-z0-9._-]+)/)?.[1];
    if (!id) throw new Error("Missing job id");
    const watch = Bun.spawn([process.execPath, "run", "narrationlayer", "watch", id], {
      env: { ...process.env, NARRATIONLAYER_DATA_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => watch.kill(), 8000);
    try {
      const reader = watch.stdout.getReader();
      const first = await reader.read();
      const initial = new TextDecoder().decode(first.value);
      expect(initial).toContain("(0/1)");
      expect(initial).not.toContain("done");
      await cli(root, ["render", id]);
      let remaining = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remaining += new TextDecoder().decode(chunk.value);
      }
      expect(await watch.exited).toBe(0);
      expect(remaining).toContain("done (1/1)");
    } finally { clearTimeout(timer); watch.kill(); await watch.exited; }
  });
}, 15_000);

async function gateFixture(root: string, expertWpm: number, deficit?: number, expertOnly = false) {
  const html = path.join(root, "display.html");
  await Bun.write(html, '<script>{"text":"Synthetic narration."}</script>');
  for (const [id, wpm] of [["c1a", expertWpm], ["c1q", 160]] as const) {
    if (expertOnly && id === "c1q") continue;
    const dir = path.join(root, "segments", id);
    await mkdir(dir, { recursive: true });
    await Bun.write(path.join(dir, "words.json"), JSON.stringify([
      { word: "Synthetic", start: 0, end: 30 / wpm },
      { word: "narration", start: 30 / wpm, end: 120 / wpm },
    ]));
    if (deficit !== undefined) {
      const proc = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=6000:duration=1", "-af", `volume=${id === "c1a" ? -deficit : 0}dB`,
        "-y", path.join(dir, `${id}.mp3`)], { stdout: "pipe", stderr: "pipe" });
      const error = await new Response(proc.stderr).text();
      expect(await proc.exited, error).toBe(0);
    }
  }
  return runGate(parseArgs(["--html", html, "--job", root]));
}

for (const [wpm, status] of [[155, "PASS"], [180, "FAIL"]] as const) {
  test(`mutation 39: gate checks existing expert segments at ${wpm} WPM`, async () => {
    await temporary(async (root) => {
      const results = await gateFixture(root, wpm);
      expect(results.find((r) => r.name === "EXPERT SPEED BAND (median WPM)")?.status).toBe(status);
    });
  });
}

for (const [deficit, status] of [[11, "PASS"], [13, "FAIL"]] as const) {
  test(`mutation 40: unanchored spectral gate at ${deficit} dB deficit`, async () => {
    await temporary(async (root) => {
      const results = await gateFixture(root, 155, deficit);
      expect(results.find((r) => r.name === "EXPERT SPECTRAL FLOOR (legacy, no --anchor-job)")?.status).toBe(status);
    });
  });
}

test("mutation 39: expert-only pace fixture is skipped", async () => {
  await temporary(async (root) => {
    const results = await gateFixture(root, 155, undefined, true);
    const pace = results.find((r) => r.name === "EXPERT SPEED BAND (median WPM)");
    expect(pace?.status).toBe("SKIPPED");
    expect(pace?.lines).toEqual(["SKIPPED: no job artifacts (missing expert or host words.json)."]);
  });
});
