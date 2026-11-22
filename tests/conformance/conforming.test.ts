import { expect, test } from "bun:test";
const runtime = process.env.CONFORMANCE_BUN ?? process.execPath;
for (const mode of ["timer", "two", "eight", "serial", "abort", "events"]) test(`every active row accepts conforming ${mode}`, async () => {
  const script = `import {conforming} from './tests/conformance/conforming-engines'; import {registry,cases,runCase} from './src/engine/conformance/runner'; const failed=[]; for(const row of registry.filter(r=>r.active)) if((await runCase(row.id,conforming(${JSON.stringify(mode)}),cases[row.id])).result!=='pass')failed.push(row.id); console.log(JSON.stringify(failed));`;
  const p = Bun.spawn([runtime, "--preload", "./src/engine/conformance/preload.ts", "--eval", script], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const watchdog = setTimeout(() => { expired = true; p.kill(9); }, 1500);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(expired, `${mode} child watchdog`).toBe(false);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual([]);
  } finally { clearTimeout(watchdog); if (p.exitCode === null) p.kill(9); }
});
