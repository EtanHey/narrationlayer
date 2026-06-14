import type { RenderManifest, WordsFile } from "./schema.js";

// Canonical, reusable teleprompter/playlist backbone. The V4 listen-through
// dashboard imports these three pieces (styles + markup + runtime) so every
// dashboard inherits one verified source of truth for: audio scrub (two-way),
// word-click SEEK (no restart), unplayed-section load+play, jumpTo SEEKS-never-
// restarts, j/k repeat, Back/Next, scrubber drag-guard, and active-word
// auto-scroll. Behavior is verified by tests/dashboard-dom.test.ts.

export interface TeleprompterSegment {
  id: string;
  title: string;
  script: string;
  audio_path: string;
  audio_url: string;
  duration_seconds: number;
  words_path: string;
  words: WordsFile;
}

export interface TeleprompterPayload {
  manifest: RenderManifest;
  segments: TeleprompterSegment[];
}

function escapeScriptJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export function teleprompterStyles(): string {
  return `
    .workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
      gap: 20px;
      align-items: start;
    }
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
    .scrubber-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      margin: 0 0 12px;
    }
    .scrubber {
      width: 100%;
      min-width: 0;
      accent-color: var(--accent);
    }
    .time-readout {
      color: var(--muted);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
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
      max-height: 60vh;
      overflow-y: auto;
      scroll-behavior: smooth;
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
    .timing-status[data-state="unavailable"] { color: var(--warn); }`;
}

export function renderTeleprompterMarkup(payload: TeleprompterPayload): string {
  return `
      <div class="workbench">
        <section class="panel">
          <h2 id="segment-title"></h2>
          <audio id="audio" controls preload="metadata"></audio>
          <div class="scrubber-row">
            <input id="scrubber" class="scrubber" type="range" min="0" max="0" step="0.01" value="0" aria-label="Seek">
            <span id="time-readout" class="time-readout">0:00 / 0:00</span>
          </div>
          <div class="audio-controls">
            <button id="previous-segment" class="control-button" type="button">Back</button>
            <button id="play-all" class="control-button" type="button">Play all</button>
            <button id="next-segment" class="control-button" type="button">Next</button>
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
  <script id="dashboard-data" type="application/json">${escapeScriptJson(payload)}</script>`;
}

export function teleprompterRuntimeScript(): string {
  return `
    const payload = JSON.parse(document.getElementById("dashboard-data").textContent);
    const audio = document.getElementById("audio");
    const script = document.getElementById("script");
    const title = document.getElementById("segment-title");
    const teleprompter = document.getElementById("teleprompter");
    const timingStatus = document.getElementById("timing-status");
    const playAllButton = document.getElementById("play-all");
    const previousSegmentButton = document.getElementById("previous-segment");
    const nextSegmentButton = document.getElementById("next-segment");
    const stopAllButton = document.getElementById("stop-all");
    const scrubber = document.getElementById("scrubber");
    const timeReadout = document.getElementById("time-readout");
    const tabs = Array.from(document.querySelectorAll(".segment-tab"));
    let activeSegment = null;
    let activeSegmentIndex = 0;
    let playAllEnabled = false;
    let wordNodes = [];
    let scrubbing = false;
    let activeWordNode = null;

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

    function segmentDuration() {
      const audioDuration = Number(audio.duration);
      if (Number.isFinite(audioDuration) && audioDuration > 0) return audioDuration;
      const fallback = activeSegment ? Number(activeSegment.duration_seconds) : 0;
      return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
    }

    function formatTime(seconds) {
      const clean = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      const minutes = Math.floor(clean / 60);
      const wholeSeconds = Math.floor(clean % 60);
      return minutes + ":" + String(wholeSeconds).padStart(2, "0");
    }

    function updateScrubberBounds() {
      const duration = segmentDuration();
      scrubber.max = String(duration);
      scrubber.disabled = duration <= 0;
    }

    function updateTimeReadout() {
      timeReadout.textContent = formatTime(audio.currentTime) + " / " + formatTime(segmentDuration());
    }

    function updateScrubberFromAudio() {
      updateScrubberBounds();
      // While the user is actively dragging the scrubber, do not let playback
      // timeupdates yank the thumb away from where they are dragging.
      if (!scrubbing) {
        scrubber.value = String(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      }
      updateTimeReadout();
    }

    function seekToTime(targetTime) {
      if (!Number.isFinite(targetTime)) return;
      const duration = segmentDuration();
      const clamped = duration > 0 ? Math.min(Math.max(targetTime, 0), duration) : Math.max(targetTime, 0);
      audio.currentTime = clamped;
      scrubber.value = String(clamped);
      setActiveWord(clamped);
      updateTimeReadout();
    }

    function loadAudio() {
      if (typeof audio.load === "function") {
        audio.load();
      }
    }

    function renderSegmentWords() {
      teleprompter.innerHTML = "";
      activeWordNode = null;
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
    }

    function setSegment(index, options = {}) {
      const targetIndex = Math.min(Math.max(index, 0), payload.segments.length - 1);
      const targetTime = Number.isFinite(options.seekTime) ? options.seekTime : 0;
      const nextSegment = payload.segments[targetIndex];
      // Only reload the audio element and rebuild the teleprompter when we are
      // actually moving to a different segment. Re-selecting the active segment
      // must SEEK, never reload-and-restart from zero.
      const segmentChanged =
        activeSegment === null ||
        targetIndex !== activeSegmentIndex ||
        nextSegment.audio_url !== activeSegment.audio_url;
      activeSegment = nextSegment;
      activeSegmentIndex = targetIndex;
      tabs.forEach((tab, tabIndex) => tab.classList.toggle("active", tabIndex === targetIndex));
      title.textContent = activeSegment.title;
      script.textContent = activeSegment.script;
      if (segmentChanged) {
        audio.src = activeSegment.audio_url;
        loadAudio();
        renderSegmentWords();
      }
      seekToTime(targetTime);
      updateScrubberFromAudio();
      if (options.play) {
        playAudio();
      }
    }

    function jumpToSegment(index, options = {}) {
      if (!payload.segments.length) return;
      const targetIndex = Math.min(Math.max(index, 0), payload.segments.length - 1);
      let seekTime;
      if (Number.isFinite(options.seekTime)) {
        seekTime = options.seekTime; // explicit seek target wins (e.g. word/script)
      } else if (targetIndex === activeSegmentIndex && activeSegment !== null) {
        seekTime = audio.currentTime; // same segment: keep position, do not restart
      } else {
        seekTime = 0; // new (possibly never-played) segment: start at its beginning
      }
      setSegment(targetIndex, { play: Boolean(options.play), seekTime });
    }

    function moveSegment(delta, options = {}) {
      // No forced seekTime: a genuine segment change starts at 0, while a clamped
      // no-op at a boundary keeps position instead of restarting.
      jumpToSegment(activeSegmentIndex + delta, {
        play: Boolean(options.play),
      });
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
      let nextActive = null;
      for (const node of wordNodes) {
        const start = Number(node.dataset.start);
        const end = Number(node.dataset.end);
        const isActive = current >= start && current < end;
        node.classList.toggle("active", isActive);
        if (isActive) nextActive = node;
      }
      // Only scroll when the active word actually changes, so long scripts keep
      // the spoken word in view without thrashing scroll every animation frame.
      if (nextActive !== activeWordNode) {
        activeWordNode = nextActive;
        if (activeWordNode && typeof activeWordNode.scrollIntoView === "function") {
          activeWordNode.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    }

    function seekToWord(event) {
      const node = event.currentTarget;
      const targetTime = Number(node.dataset.start);
      if (!Number.isFinite(targetTime)) return;
      const wasPlaying = !audio.paused;
      seekToTime(targetTime);
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
        jumpToSegment(Number(tab.dataset.segmentIndex), { play: true });
      });
    }
    function playAll() {
      setPlayAllEnabled(true);
      playAudio();
    }
    playAllButton.addEventListener("click", playAll);
    previousSegmentButton.addEventListener("click", () => {
      setPlayAllEnabled(false);
      moveSegment(-1, { play: true });
    });
    nextSegmentButton.addEventListener("click", () => {
      setPlayAllEnabled(false);
      moveSegment(1, { play: true });
    });
    stopAllButton.addEventListener("click", () => {
      setPlayAllEnabled(false);
      audio.pause();
    });
    scrubber.addEventListener("input", () => {
      scrubbing = true;
      seekToTime(Number(scrubber.value));
    });
    scrubber.addEventListener("change", () => {
      seekToTime(Number(scrubber.value));
      scrubbing = false;
    });
    scrubber.addEventListener("pointerup", () => {
      scrubbing = false;
    });
    scrubber.addEventListener("blur", () => {
      scrubbing = false;
    });
    audio.addEventListener("loadedmetadata", updateScrubberFromAudio);
    audio.addEventListener("timeupdate", updateScrubberFromAudio);
    audio.addEventListener("ended", () => {
      if (!playAllEnabled) return;
      const nextIndex = activeSegmentIndex + 1;
      if (nextIndex >= payload.segments.length) {
        setPlayAllEnabled(false);
        return;
      }
      jumpToSegment(nextIndex, { play: true });
    });
    script.addEventListener("click", () => {
      setPlayAllEnabled(false);
      jumpToSegment(activeSegmentIndex, { play: true, seekTime: 0 });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "j" && event.key !== "k") return;
      if (event.target && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(event.target.tagName)) return;
      event.preventDefault();
      setPlayAllEnabled(false);
      moveSegment(event.key === "j" ? 1 : -1, { play: true });
    });
    jumpToSegment(0);
    requestAnimationFrame(updateTeleprompter);
  `;
}
