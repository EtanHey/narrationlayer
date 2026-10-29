// Real-browser visual proof for the P2a LOCAL HARNESS (not signed-in Lakebed), after the
// tests/realbrowser/seek-realbrowser.mjs pattern. Needs `agent-browser start` to exit 0 (agent Chrome
// on CDP 9333; each run uses its own context) and PLAYWRIGHT_CORE=<a playwright-core directory>.
// Run: PLAYWRIGHT_CORE=<dir> bun examples/phone-sync-prototype/proof/capture.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHarness } from "../harness/serve.ts";

const { chromium } = await import(path.join(process.env.PLAYWRIGHT_CORE, "index.js"));
const out = import.meta.dir, server = await serveHarness(0), measured = {};
for (const dir of ["screens", "gifs"]) mkdirSync(`${out}/${dir}`, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");

async function open(width) {
  const phone = width < 500;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.locator("button[aria-label=Play]:not([disabled])").waitFor();
  const field = (q = "q-orbit-r1", f = "answer") => page.locator(`[data-field='${q}:${f}']`);
  const until = (state, q, f) => page.locator(`[data-field='${q ?? "q-orbit-r1"}:${f ?? "answer"}'][data-state=${state}]`).waitFor()
    .then(() => page.waitForTimeout(260)); // let the 200 ms status transition settle before a still
  // Harness controls are dispatched, not clicked, so the page does not scroll to the banner mid-GIF.
  const harness = name => page.getByRole("button", { name, exact: true }).dispatchEvent("click");
  const question = n => page.locator("main section").nth(n + 1);
  return { context, page, field, until, harness, question, player: page.getByRole("region", { name: "Synthetic test tone player" }) };
}

async function gif(name, steps) {
  const s = await open(390), dir = mkdtempSync(path.join(os.tmpdir(), "p2a-gif-")), t0 = Date.now();
  let on = true, n = 0;
  const loop = (async () => { while (on) await s.page.screenshot({ path: `${dir}/${String(n++).padStart(4, "0")}.png` }); })();
  await steps(s);
  await s.page.waitForTimeout(700);
  on = false;
  await loop;
  const fps = n / ((Date.now() - t0) / 1000);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", fps.toFixed(2), "-i", `${dir}/%04d.png`, "-vf",
    "scale=390:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none", `${out}/gifs/${name}.gif`]);
  rmSync(dir, { recursive: true });
  measured[`gif:${name}`] = { frames: n, fps: Number(fps.toFixed(2)) };
  await s.context.close();
}

for (const width of [1280, 390]) {
  const { context, page, field, until, harness, question, player } = await open(width);
  const shot = async (name, target) => {
    const box = target && await target.boundingBox(), pad = 16, top = await page.evaluate(() => scrollY), path = `${out}/screens/${width}-${name}.png`;
    await page.screenshot(box ? { path, fullPage: true, clip: { x: Math.max(0, box.x - pad), y: box.y + top - pad,
      width: Math.min(width, box.width + 2 * pad), height: box.height + 2 * pad } } : { path, fullPage: true });
  };
  const audio = () => page.evaluate(() => { const a = document.querySelector("audio"); return { t: a.currentTime, paused: a.paused, rate: a.playbackRate, duration: a.duration }; });
  await shot("page-initial");
  await shot("player-paused", player);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(1600);
  const playing = await audio();
  await shot("player-playing", player);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.locator("[data-word='3']").click();
  const seekWhilePaused = await audio();
  await page.locator("[data-speed='1.5']").click();
  await shot("player-seek-paused-speed", player);
  await shot("state-empty", question(0));
  await field().locator("textarea").fill("The second tone, where the pitch drops.");
  await shot("state-draft", question(0));
  await harness("Slow network");
  await field().getByRole("button", { name: "Save" }).click();
  await until("saving");
  await shot("state-saving", question(0));
  await until("saved");
  await shot("state-saved", question(0));
  await harness("Slow network");
  await page.waitForTimeout(260);
  await shot("page-final");
  measured[width] = { playing, seekWhilePaused, ...(await page.evaluate(async () => ({
    scrollWidth: document.documentElement.scrollWidth, innerWidth,
    toneBytes: (await (await fetch(document.querySelector("audio").src)).blob()).size,
    under44: [...document.querySelectorAll("main button, main input, main textarea")].map(el => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(x => x.w < 44 || x.h < 44) }))) };
  await context.close();
}

await gif("play-pause-seek", async ({ page }) => {
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(1500);
  await page.locator("[data-word='4']").click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.locator("input[type=range]").fill("1.6");
  await page.waitForTimeout(500);
  await page.locator("[data-word='2']").click();
});
await gif("edit-save", async ({ field, until, harness, question }) => {
  await question(0).evaluate(el => el.scrollIntoView({ block: "start" }));
  await harness("Slow network");
  await field().locator("textarea").pressSequentially("The second tone.", { delay: 45 });
  await field().getByRole("button", { name: "Save" }).click();
  await until("saved");
});
writeFileSync(`${out}/measurements.json`, `${JSON.stringify(measured, null, 2)}\n`);
await browser.close();
server.stop(true);
console.log(JSON.stringify(measured));
