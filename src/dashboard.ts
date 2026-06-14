import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { pathsForJob } from "./job-store.js";
import { getJobResult } from "./service.js";
import type { WordsFile } from "./schema.js";
import {
  renderTeleprompterMarkup,
  teleprompterRuntimeScript,
  teleprompterStyles,
  type TeleprompterPayload,
  type TeleprompterSegment,
} from "./teleprompter.js";

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

export interface DashboardOptions {
  // When set, audio is referenced as `${audioBaseUrl}/<basename>` (HTTP) instead
  // of a file:// URL. The server behind audioBaseUrl MUST support HTTP range
  // requests (Accept-Ranges / 206) — without ranges the browser's
  // `audio.seekable` is empty and word-click seeking / scrubbing cannot work.
  audioBaseUrl?: string;
}

function resolveAudioUrl(audioPath: string, audioBaseUrl?: string): string {
  if (!audioPath) return "";
  if (audioBaseUrl) {
    const base = audioBaseUrl.replace(/\/+$/, "");
    return `${base}/${encodeURIComponent(path.basename(audioPath))}`;
  }
  return pathToFileURL(audioPath).href;
}

// The dashboard owns only the page shell (head + sidebar + segment tabs); the
// teleprompter/playlist backbone (styles, markup, runtime) is the canonical
// reusable module in ./teleprompter.ts so V4 and every other dashboard share it.
function renderHtml(payload: TeleprompterPayload): string {
  const firstSegment = payload.segments[0];
  const title = firstSegment
    ? `${firstSegment.title} - Agent Narration Dashboard`
    : "Agent Narration Dashboard";
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
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .panel h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
    ${teleprompterStyles()}
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
      ${renderTeleprompterMarkup(payload)}
    </main>
  </div>
  <script>${teleprompterRuntimeScript()}</script>
</body>
</html>`;
}

export async function createDashboardDemo(
  jobId: string,
  dataDir?: string,
  options: DashboardOptions = {},
): Promise<string> {
  const { manifest } = await getJobResult(jobId, dataDir);
  const segments = await Promise.all(
    manifest.segments.map(
      async (segment): Promise<TeleprompterSegment> => ({
        id: segment.id,
        title: segment.title,
        script: segment.script,
        audio_path: segment.audio_path,
        audio_url: resolveAudioUrl(segment.audio_path, options.audioBaseUrl),
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
      }),
    ),
  );
  const outputPath = path.join(
    pathsForJob(jobId, dataDir).jobDir,
    "dashboard.html",
  );
  await writeFile(outputPath, renderHtml({ manifest, segments }), "utf8");
  return outputPath;
}
