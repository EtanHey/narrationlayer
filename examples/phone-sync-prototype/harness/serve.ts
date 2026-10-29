import { Scanner } from "@tailwindcss/oxide";
import { compile } from "tailwindcss";

// Serves the LOCAL HARNESS page on 127.0.0.1. CSS is compiled the way Lakebed's dev server does it
// (lakebed/dist/cli/styles.js): Tailwind candidates scanned from the client files, no CSS files.
// Run: bun examples/phone-sync-prototype/harness/serve.ts   (PORT, default 4317)
const here = import.meta.dir;
export async function serveHarness(port: number) {
  const build = await Bun.build({ entrypoints: [`${here}/main.tsx`], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "harness build failed");
  const js = await build.outputs[0]!.text();
  const files = ["../capsule/client/player.tsx", "../capsule/client/sync.tsx", "main.tsx"];
  const candidates = new Scanner({ sources: [] }).scanFiles(await Promise.all(files.map(async f =>
    ({ content: await Bun.file(`${here}/${f}`).text(), extension: "tsx" }))));
  const css = (await compile(await Bun.file(require.resolve("tailwindcss/index.css")).text())).build(candidates);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOCAL HARNESS: phone sync</title><style>${css}</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>`;
  return Bun.serve({ port, hostname: "127.0.0.1", fetch: req => new URL(req.url).pathname === "/main.js"
    ? new Response(js, { headers: { "content-type": "text/javascript" } })
    : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) });
}
if (import.meta.main) console.log(`LOCAL HARNESS: ${(await serveHarness(Number(process.env.PORT ?? 4317))).url}`);
