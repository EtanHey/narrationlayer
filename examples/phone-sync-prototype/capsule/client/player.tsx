/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";

// Synthetic test tone rendered in this browser: no speech, cloned or hosted audio. Each fake word is a
// tone burst; [label, start, end, hz] are invented timings. Seek logic ports src/teleprompter.ts
// seekToTime/seekToWord (no import: the capsule build resolves only inside capsule/).
export const WORDS = [["Synthetic", 0.2, 1.2, 392], ["test", 1.35, 2.15, 330], ["tone", 2.3, 3.3, 440],
  ["for", 3.45, 4.25, 294], ["phone", 4.4, 5.3, 494], ["sync", 5.45, 6.35, 523]] as const;
export const LENGTH = 6.5;
const RATE = 22050, GAP = 0.075, SPEEDS = [0.75, 1, 1.25, 1.5];
export const press = "transition-[transform,color,background-color] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D6B67]";

export async function renderTone(): Promise<Blob> {
  const ctx = new OfflineAudioContext(1, RATE * LENGTH, RATE);
  for (const [, start, end, hz] of WORDS) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.04);
    gain.gain.setValueAtTime(0.25, end - 0.08);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end);
  }
  const pcm = (await ctx.startRendering()).getChannelData(0), wav = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const put = (at: number, v: number | string, bytes = 4) => typeof v === "string"
    ? [...v].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)))
    : bytes === 4 ? wav.setUint32(at, v, true) : wav.setUint16(at, v, true);
  put(0, "RIFF"); put(4, 36 + pcm.length * 2); put(8, "WAVE"); put(12, "fmt "); put(16, 16); put(20, 1, 2);
  put(22, 1, 2); put(24, RATE); put(28, RATE * 2); put(32, 2, 2); put(34, 16, 2); put(36, "data"); put(40, pcm.length * 2);
  pcm.forEach((s, i) => wav.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([wav], { type: "audio/wav" });
}

const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const icon = (d: string) => <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current"><path d={d} /></svg>;

export function Player({ source = renderTone }: { source?: () => Promise<Blob> }) {
  const audio = useRef<HTMLAudioElement>(null), scrubbing = useRef(false);
  const [url, setUrl] = useState<string>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  useEffect(() => {
    let made = "";
    void source().then(blob => setUrl(made = URL.createObjectURL(blob)));
    return () => { if (made) URL.revokeObjectURL(made); };
  }, []);
  useEffect(() => { const el = audio.current!; el.playbackRate = el.defaultPlaybackRate = speed; }, [speed, url]);
  // While dragging, playback must not yank the thumb (teleprompter `scrubbing`).
  const sync = () => { if (!scrubbing.current) setTime(audio.current!.currentTime); };
  useEffect(() => { // timeupdate is coarse; follow frames while playing so the playhead moves evenly
    if (!playing) return;
    let frame = 0;
    const tick = () => { sync(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const seek = (target: number) => {
    const t = Math.min(Math.max(target, 0), LENGTH);
    audio.current!.currentTime = t;
    setTime(t);
  };
  const tapWord = (start: number) => {
    const el = audio.current!, wasPlaying = !el.paused;
    seek(start);
    if (wasPlaying) void el.play();
  };
  const scrub = (e: Event, done: boolean) => {
    scrubbing.current = !done;
    seek(Number((e.currentTarget as HTMLInputElement).value));
  };
  return (
    <section aria-label="Synthetic test tone player" className="mt-6 rounded-[14px] border border-[#15212E]/12 bg-white/60 p-4">
      <audio ref={audio} src={url} preload="auto" onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); sync(); }} onTimeUpdate={sync} />
      <div className="flex items-baseline justify-between gap-3 text-[13px] text-[#5B6670]">
        <span>Synthetic test tone</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">{clock(time)} / {clock(LENGTH)}</span>
      </div>
      <div className="relative mt-3 h-20">
        {WORDS.map(([word, start, end, hz], i) => (
          <button type="button" key={word} data-word={i} aria-label={`Seek to “${word}”`} onClick={() => tapWord(start)}
            className={`${press} absolute inset-y-0 flex flex-col justify-end rounded-[6px]`}
            style={{ left: `${((start - GAP) / LENGTH) * 100}%`, width: `${((end - start + 2 * GAP) / LENGTH) * 100}%` }}>
            <span className="flex h-12 items-end px-[8%]">
              <span className="relative block w-full overflow-hidden rounded-[3px] bg-[#15212E]/14" style={{ height: `${(hz - 220) / 3.2}%` }}>
                <span className="absolute inset-0 origin-left bg-[#1D6B67]"
                  style={{ transform: `scaleX(${Math.min(Math.max((time - start) / (end - start), 0), 1)})` }} />
              </span>
            </span>
            <span className="mt-1.5 block truncate text-center text-[12px] text-[#5B6670]">{word}</span>
          </button>
        ))}
        <span aria-hidden="true" className="pointer-events-none absolute top-0 h-12 w-0.5 rounded-full bg-[#15212E]"
          style={{ left: `${(time / LENGTH) * 100}%` }} />
      </div>
      <input type="range" aria-label="Seek" min={0} max={LENGTH} step={0.01} value={time}
        onInput={e => scrub(e, false)} onChange={e => scrub(e, true)} onBlur={() => (scrubbing.current = false)}
        className="mt-1 h-11 w-full cursor-pointer accent-[#1D6B67]" />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" aria-label={playing ? "Pause" : "Play"} disabled={!url}
          onClick={() => (audio.current!.paused ? void audio.current!.play() : audio.current!.pause())}
          className={`${press} grid h-12 w-12 place-items-center rounded-[12px] bg-[#15212E] text-white disabled:opacity-40`}>
          {icon(playing ? "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" : "M8 5.5v13l10.5-6.5z")}
        </button>
        <button type="button" aria-label="Restart" onClick={() => seek(0)}
          className={`${press} grid h-12 w-12 place-items-center rounded-[12px] border border-[#15212E]/15 text-[#15212E]`}>
          {icon("M12 5V2L7.5 6.5 12 11V8a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8z")}
        </button>
        <div role="group" aria-label="Playback speed" className="ml-auto grid grid-cols-4 rounded-[12px] bg-[#15212E]/[0.06] p-0.5">
          {SPEEDS.map(s => (
            <button type="button" key={s} data-speed={s} aria-pressed={s === speed} onClick={() => setSpeed(s)}
              className={`${press} h-11 min-w-11 rounded-[10px] px-1.5 text-[13px] tabular-nums ` +
                (s === speed ? "bg-white text-[#15212E] shadow-[0_1px_2px_rgb(21_33_46/0.12)]" : "text-[#5B6670]")}>{s}×</button>
          ))}
        </div>
      </div>
    </section>
  );
}
