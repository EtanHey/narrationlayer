import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { pathsForJob } from "./job-store.js";
import { getJobResult } from "./service.js";
import type { RenderManifest, WordsFile } from "./schema.js";

interface DashboardSegment {
  id: string;
  title: string;
  script: string;
  audio_path: string;
  audio_url: string;
  duration_seconds: number;
  words_path: string;
  words: WordsFile;
}

interface DashboardPayload {
  manifest: RenderManifest;
  segments: DashboardSegment[];
}

function escapeScriptJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readWordsFile(wordsPath: string): Promise<WordsFile> {
  return JSON.parse(await readFile(wordsPath, "utf8")) as WordsFile;
}

function renderHtml(payload: DashboardPayload): string {
  const firstSegment = payload.segments[0];
  const title = firstSegment ? `${firstSegment.title} - Agent Narration Dashboard` : "Agent Narration Dashboard";
  const navItems = payload.segments
    .map(
      (segment, index) => `
        <button class="segment-tab${index === 0 ? " active" : ""}" type="button" data-segment-index="${index}">
          <span>${escapeHtml(segment.title)}</span>
          <small>${segment.duration_seconds.toFixed(2)}s</small>
        </button>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --text: #171717;
      --muted: #666b72;
      --line: #d8ddd8;
      --accent: #0c7c59;
      --accent-weak: #dff3e9;
      --warn: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(220px, 280px) 1fr;
      min-height: 100vh;
    }
    aside {
      border-right: 1px solid var(--line);
      background: #eef2ef;
      padding: 20px;
    }
    main { padding: 24px; }
    h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: 0; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .segment-list { display: grid; gap: 8px; }
    .segment-tab {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      padding: 10px 12px;
      text-align: left;
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      cursor: pointer;
    }
    .segment-tab.active { border-color: var(--accent); background: var(--accent-weak); }
    .segment-tab small { color: var(--muted); white-space: nowrap; }
    .workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
      gap: 20px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .panel h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
    .audio-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .control-button {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-height: 34px;
      padding: 6px 10px;
    }
    .control-button.active {
      border-color: var(--accent);
      background: var(--accent-weak);
    }
    audio { width: 100%; margin: 10px 0 16px; }
    .script {
      white-space: pre-wrap;
      color: #303236;
      margin: 0;
    }
    .teleprompter {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-content: flex-start;
      min-height: 220px;
    }
    .word {
      border: 1px solid var(--line);
      background: #fafafa;
      border-radius: 5px;
      padding: 5px 7px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .word:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .word.active {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    .timing-status {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .timing-status[data-state="unavailable"] { color: var(--warn); }
    @media (max-width: 820px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .workbench { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Agent Narration Dashboard</h1>
      <div class="meta">
        <div>Job: ${escapeHtml(payload.manifest.job_id)}</div>
        <div>Renderer: ${escapeHtml(payload.manifest.renderer)}</div>
        <div>Total: ${payload.manifest.total_duration_seconds.toFixed(2)}s</div>
      </div>
      <div class="segment-list">${navItems}</div>
    </aside>
    <main>
      <div class="workbench">
        <section class="panel">
          <h2 id="segment-title"></h2>
          <audio id="audio" controls preload="metadata"></audio>
          <div class="audio-controls">
            <button id="play-all" class="control-button" type="button">Play all</button>
            <button id="stop-all" class="control-button" type="button">Stop</button>
          </div>
          <pre id="script" class="script"></pre>
        </section>
        <section class="panel">
          <h2>Teleprompter</h2>
          <div id="teleprompter" class="teleprompter" aria-label="teleprompter"></div>
          <div id="timing-status" class="timing-status"></div>
        </section>
      </div>
    </main>
  </div>
  <script id="dashboard-data" type="application/json">${escapeScriptJson(payload)}</script>
  <script>
    const payload = JSON.parse(document.getElementById("dashboard-data").textContent);
    const audio = document.getElementById("audio");
    const script = document.getElementById("script");
    const title = document.getElementById("segment-title");
    const teleprompter = document.getElementById("teleprompter");
    const timingStatus = document.getElementById("timing-status");
    const playAllButton = document.getElementById("play-all");
    const stopAllButton = document.getElementById("stop-all");
    const tabs = Array.from(document.querySelectorAll(".segment-tab"));
    let activeSegment = null;
    let activeSegmentIndex = 0;
    let playAllEnabled = false;
    let wordNodes = [];

    function playAudio() {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }

    function setPlayAllEnabled(enabled) {
      playAllEnabled = enabled;
      playAllButton.classList.toggle("active", enabled);
    }

    function setSegment(index, options = {}) {
      activeSegment = payload.segments[index];
      activeSegmentIndex = index;
      tabs.forEach((tab, tabIndex) => tab.classList.toggle("active", tabIndex === index));
      title.textContent = activeSegment.title;
      script.textContent = activeSegment.script;
      audio.src = activeSegment.audio_url;
      audio.currentTime = 0;
      teleprompter.innerHTML = "";
      const words = activeSegment.words.words.length
        ? activeSegment.words.words
        : estimateWords(activeSegment.script, activeSegment.duration_seconds);
      wordNodes = words.map((word) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "word";
        node.textContent = word.word;
        node.setAttribute("aria-label", "Seek to " + word.word);
        node.dataset.start = String(word.start);
        node.dataset.end = String(word.end);
        node.addEventListener("click", seekToWord);
        teleprompter.appendChild(node);
        return node;
      });
      const timing = activeSegment.words.timing;
      timingStatus.dataset.state = timing.status;
      timingStatus.textContent = timing.status === "available"
        ? "Timing: " + timing.source
        : "Timing unavailable: " + (timing.reason || "backend did not provide word timing") + "; displaying estimated script timing";
      if (options.play) {
        playAudio();
      }
    }

    function estimateWords(text, durationSeconds) {
      const words = String(text || "").trim().split(/\\s+/).filter(Boolean);
      if (!words.length) return [];
      const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : words.length / 2.5;
      return words.map((word, index) => ({
        index,
        word,
        start: Number((duration * (index / words.length)).toFixed(3)),
        end: Number((duration * ((index + 1) / words.length)).toFixed(3)),
      }));
    }

    function setActiveWord(current) {
      for (const node of wordNodes) {
        const start = Number(node.dataset.start);
        const end = Number(node.dataset.end);
        node.classList.toggle("active", current >= start && current < end);
      }
    }

    function seekToWord(event) {
      const node = event.currentTarget;
      const targetTime = Number(node.dataset.start);
      if (!Number.isFinite(targetTime)) return;
      const wasPlaying = !audio.paused;
      audio.currentTime = targetTime;
      setActiveWord(targetTime);
      if (wasPlaying) {
        playAudio();
      }
    }

    function updateTeleprompter() {
      if (!activeSegment) return;
      setActiveWord(audio.currentTime);
      requestAnimationFrame(updateTeleprompter);
    }

    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        setPlayAllEnabled(false);
        setSegment(Number(tab.dataset.segmentIndex));
      });
    }
    function playAll() {
      setPlayAllEnabled(true);
      playAudio();
    }
    playAllButton.addEventListener("click", playAll);
    stopAllButton.addEventListener("click", () => {
      setPlayAllEnabled(false);
      audio.pause();
    });
    audio.addEventListener("ended", () => {
      if (!playAllEnabled) return;
      const nextIndex = activeSegmentIndex + 1;
      if (nextIndex >= payload.segments.length) {
        setPlayAllEnabled(false);
        return;
      }
      setSegment(nextIndex, { play: true });
    });
    setSegment(0);
    requestAnimationFrame(updateTeleprompter);
  </script>
</body>
</html>`;
}

export async function createDashboardDemo(jobId: string, dataDir?: string): Promise<string> {
  const { manifest } = await getJobResult(jobId, dataDir);
  const segments = await Promise.all(
    manifest.segments.map(async (segment): Promise<DashboardSegment> => ({
      id: segment.id,
      title: segment.title,
      script: segment.script,
      audio_path: segment.audio_path,
      audio_url: segment.audio_path ? pathToFileURL(segment.audio_path).href : "",
      duration_seconds: segment.duration_seconds,
      words_path: segment.words_path,
      words: segment.words_path
        ? await readWordsFile(segment.words_path)
        : {
            job_id: manifest.job_id,
            segment_id: segment.id,
            timing: {
              status: "unavailable",
              source: manifest.renderer,
              reason: "segment_has_no_words_path",
            },
            words: [],
          },
    })),
  );
  const outputPath = path.join(pathsForJob(jobId, dataDir).jobDir, "dashboard.html");
  await writeFile(outputPath, renderHtml({ manifest, segments }), "utf8");
  return outputPath;
}
