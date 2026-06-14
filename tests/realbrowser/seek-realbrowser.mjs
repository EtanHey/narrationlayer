// Real-browser seekability check for the narration dashboard.
//
// STATUS: STAGED. Not run in `bun test` (needs a real browser + an idle box).
// Closes the gap that the happy-dom tests cannot cover: they stub the media
// element, so they prove the JS logic but NOT that a real browser can actually
// seek. This harness serves the REAL generated dashboard over a RANGE-CAPABLE
// HTTP server, points it at a valid WAV, drives a headless browser, and asserts
// audio.seekable is non-empty and a seek sticks.
//
// RAM SAFETY: refuses to run while the heavy ML stack (whisper-server / large
// python) is loaded — run heavy jobs one-at-a-time. Run this only when idle:
//   bun add -d playwright && bunx playwright install chromium   # one-time
//   bun run tests/realbrowser/seek-realbrowser.mjs
//
// Visual previews should use Helium (open -a Helium <url>); this automated
// assertion uses headless chromium via Playwright.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createJobFromPayload, renderJob } from "../../src/service.js";
import { createDashboardDemo } from "../../src/dashboard.js";

function mlStackBusy() {
  try {
    const ps = execSync("ps aux", { encoding: "utf8" });
    // whisper-server and mlx_lm.server are persistent daemons that sit idle at
    // tens of MB and only balloon to GBs when a model is actually loaded. Gate on
    // RSS, not mere presence, so an idle daemon (or this guard's own ps/grep
    // command line) does not falsely report the box as busy.
    return ps.split("\n").some((l) => {
      if (!/whisper-server|mlx_lm|mlx-lm|comfy|Python/.test(l)) return false;
      const rss = Number(l.split(/\s+/)[5]); // RSS in KB
      return Number.isFinite(rss) && rss > 1_200_000; // a model is actually loaded
    });
  } catch {
    return false;
  }
}

// Minimal valid 16-bit PCM mono WAV (the fake renderer's mp3 bytes may not be
// browser-decodable; a real WAV guarantees the browser loads metadata + ranges).
function makeWav(seconds = 2, sampleRate = 8000) {
  const n = seconds * sampleRate;
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((i / sampleRate) * 2 * Math.PI * 220)), 44 + i * 2);
  }
  return buf;
}

function rangeRespond(bytes, req, contentType) {
  const total = bytes.length;
  const range = req.headers.get("range");
  if (!range) {
    return new Response(bytes, {
      status: 200,
      headers: { "Accept-Ranges": "bytes", "Content-Type": contentType, "Content-Length": String(total) },
    });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : total - 1;
  const slice = bytes.subarray(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(slice.length),
    },
  });
}

async function main() {
  if (mlStackBusy()) {
    console.log("DEFERRED: ML stack is loaded (whisper/mlx/large python). Re-run when idle.");
    process.exit(3);
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("SKIP: playwright not installed. Run: bun add -d playwright && bunx playwright install chromium");
    process.exit(2);
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nl-rb-"));
  const wav = makeWav();
  let server;
  try {
    await createJobFromPayload(
      {
        job_id: "rb-job",
        voice_profile: "neutral-reader",
        renderer: "fake",
        segments: [
          { id: "seg-1", title: "Intro", script: "One two three four five six.", duration_seconds: 2 },
          { id: "seg-2", title: "Body", script: "Seven eight nine ten eleven.", duration_seconds: 2 },
        ],
      },
      dataDir,
    );
    await renderJob("rb-job", dataDir);

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/dashboard.html") {
          const base = `http://localhost:${server.port}`;
          const htmlPath = await createDashboardDemo("rb-job", dataDir, { audioBaseUrl: `${base}/audio` });
          return new Response(await Bun.file(htmlPath).text(), { headers: { "Content-Type": "text/html" } });
        }
        if (url.pathname.startsWith("/audio/")) {
          return rangeRespond(wav, req, "audio/wav"); // serve the same valid WAV for any segment
        }
        return new Response("not found", { status: 404 });
      },
    });
    const dashUrl = `http://localhost:${server.port}/dashboard.html`;

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(dashUrl, { waitUntil: "load" });

    // Wait for the active audio element to have metadata + a seekable range.
    await page.waitForFunction(() => {
      const a = document.getElementById("audio");
      return a && a.readyState >= 1 && a.seekable && a.seekable.length > 0;
    }, { timeout: 10000 });

    // Drives a word-click seek and reports observable media state. Reused for
    // desktop and mobile so both prove the same backbone behavior.
    const seekProbe = async () => {
      const a = document.getElementById("audio");
      const beforeSeekable = a.seekable.length;
      const words = [...document.querySelectorAll(".word")];
      const target = words[3] || words[words.length - 1];
      const wantStart = Number(target.dataset.start);
      target.click();
      await new Promise((r) => setTimeout(r, 150));
      const workbench = document.querySelector(".workbench");
      const cols = workbench
        ? getComputedStyle(workbench).gridTemplateColumns.trim().split(/\s+/).length
        : 0;
      return { beforeSeekable, wantStart, currentTime: a.currentTime, duration: a.duration, cols };
    };
    const probeSource = `(${seekProbe.toString()})()`;
    const seekable = () => {
      const a = document.getElementById("audio");
      return a && a.readyState >= 1 && a.seekable && a.seekable.length > 0;
    };

    const result = await page.evaluate(probeSource);

    // MOBILE (V4 requirement): phone viewport + touch. Seek must still work and
    // the responsive layout must collapse the workbench to a single column.
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const mpage = await mobileCtx.newPage();
    await mpage.goto(dashUrl, { waitUntil: "load" });
    await mpage.waitForFunction(seekable, { timeout: 10000 });
    const mobile = await mpage.evaluate(probeSource);
    await mobileCtx.close();

    await browser.close();

    const landed = (r) => r.beforeSeekable > 0 && Math.abs(r.currentTime - r.wantStart) < 0.4;
    const desktopOk = landed(result);
    const mobileOk = landed(mobile) && mobile.cols === 1; // single-column at 390px
    const ok = desktopOk && mobileOk;
    console.log("DESKTOP SEEK:", JSON.stringify(result));
    console.log("MOBILE SEEK :", JSON.stringify(mobile));
    console.log(
      ok
        ? "PASS: audio.seekable populated + word-click seek landed on desktop AND mobile (single-column)."
        : `FAIL: desktopOk=${desktopOk} mobileOk=${mobileOk} — check range support / responsive layout.`,
    );
    process.exit(ok ? 0 : 1);
  } finally {
    server?.stop?.(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
