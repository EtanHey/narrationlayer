import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { hasReadText } from "../../src/engine/conformance/privacy-cases";
const root = resolve(import.meta.dir, "../.."), runtime = process.env.CONFORMANCE_BUN ?? process.execPath;
const entry = resolve(root, "src/engine/conformance/entry.ts");
const savedBinding = resolve(root, "src/engine/conformance/broken-priv-saved-log.ts");
async function run(binding: string) {
  const p = Bun.spawn([runtime, entry, "--binding", binding, ...(process.platform === "darwin" ? ["--require-containment"] : [])], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const report = JSON.parse(stdout);
  expect(code).toBe(1); expect(report.containment).toBe(process.platform === "darwin" ? "macos-sandbox" : "in-process-tripwire");
  expect(report.rows.filter((r: { result: string }) => r.result === "fail").map((r: { id: string }) => r.id)).toEqual(["PRIV-01e"]);
  expect(stderr).toContain("PRIV-01e"); expect(hasReadText(stderr)).toBe(false);
}
test("saved console.error: direct runCase is green by design while the saved log escapes", async () => {
  const script = `import binding from ${JSON.stringify(savedBinding)};import {runCase} from ${JSON.stringify(resolve(root, "src/engine/conformance/runner.ts"))};import {privacyCases} from ${JSON.stringify(resolve(root, "src/engine/conformance/privacy-cases.ts"))};console.log(JSON.stringify(await runCase('PRIV-01e',binding,privacyCases['PRIV-01e'])));`;
  const p = Bun.spawn([runtime, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0); expect(JSON.parse(out).result).toBe("pass"); expect(hasReadText(err)).toBe(true);
});
test("saved console.error: contained entry catches its exact committed fail-set", () => run(savedBinding));
for (const route of ["bound-stderr", "trace", "dir", "table", "assert", "stdout", "late", "upper"]) test(`privacy parent catches stream route ${route}`, async () => {
  const scratch = resolve(root, "docs.local/s7d-round1/tests"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(resolve(scratch, "route-")), file = resolve(dir, "binding.ts");
  const action = route === "bound-stderr" || route === "late" ? "savedWrite(text)" : route === "upper" ? "savedError(text.toUpperCase())" : route === "assert" ? "console.assert(false,text)" : route === "stdout" ? "savedOut(text)" : `console.${route}(text)`;
  writeFileSync(file, `import engine from ${JSON.stringify(resolve(root, "src/engine/conformance/engine-binding.ts"))};
const savedWrite=process.stderr.write.bind(process.stderr),savedError=console.error,savedOut=process.stdout.write.bind(process.stdout);
export default {name:'stream-${route}',create(host){const c=engine.create(host);let text='',stale=false;
return {...c,send(m){if(m?.type==='narrate')text=m.input.text;if(m?.type==='player_feedback'&&m.control_epoch===0)stale=true;c.send(m);},
events:(async function*(){for await(const e of c.events){if(e.type==='outcome'){
${route === "late" ? `if(stale){let turns=4096;const later=()=>{if(turns--)queueMicrotask(later);else if(console.error===savedError)${action};};queueMicrotask(later);}` : action}
}yield e;}})()};}};`);
  try { await run(file); } finally { rmSync(dir, { recursive: true }); }
});
