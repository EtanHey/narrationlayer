import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runConformance } from "../../src/engine/conformance/runner.js";
import { trapState } from "../../src/engine/conformance/wall-guard.js";
import networkFailSet from "./network-binding.fail-set.json";
import spawnFailSet from "./spawn-binding.fail-set.json";
import binding from "../../src/engine/conformance/null-binding.js";
const root = resolve(import.meta.dir, "../..");
const entry = resolve(root, "src/engine/conformance/entry.ts");
const runtime = process.env.CONFORMANCE_BUN ?? process.execPath;
const scratch = resolve(root, "docs.local/s0b/tests");
mkdirSync(scratch, { recursive: true });
async function run(source?: string, env = process.env, cwd = root, extra: string[] = []) {
  const dir = mkdtempSync(resolve(scratch, "fixture-"));
  const path = resolve(dir, "binding.ts");
  if (source) writeFileSync(path, source);
  const proc = Bun.spawn([runtime, entry, "--binding", source ? path : resolve(root, "src/engine/conformance/null-binding.ts"), ...extra], { cwd, env, stdout: "pipe", stderr: "pipe" });
  try { const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { stdout, stderr, code, report: stdout ? JSON.parse(stdout) : null }; }
  finally { rmSync(dir, { recursive: true }); }
}
const fixture = (capture: string, call = "saved()") => `${capture}; export default {name:"trap",create(){return {send(){try{${call}}catch{}},events:(async function*(){})(),async shutdown(){}}}};`;
const probes: [string, string, string][] = [];
for (const [module, kind] of [["node:child_process", "CONF-04"], ["node:worker_threads", "CONF-04"], ...["net", "tls", "http", "https", "dgram"].map(m => [`node:${m}`, "CONF-03"])]) {
  for (const key of Object.keys(require(module)).filter(k => typeof require(module)[k] === "function")) probes.push([`${module}.${key}`, kind, fixture(`import {${key} as saved} from '${module}'`)]);
  if (require(module).globalAgent) for (const key of ["createConnection", "addRequest"]) probes.push([`${module}.globalAgent.${key}`, kind, fixture(`import module from '${module}'; const saved=()=>module.globalAgent.${key}()`)]);
}
for (const name of ["node:timers", "node:timers/promises"]) {
  for (const key of ["setTimeout", "setInterval", "setImmediate"]) probes.push([`${name}.${key}`, "CONF-02", fixture(`import {${key} as saved} from '${name}'`)]);
}
for (const key of ["wait", "yield"]) probes.push([`node:timers/promises.scheduler.${key}`, "CONF-02", fixture(`import {scheduler} from 'node:timers/promises'; const saved=()=>scheduler.${key}()`)]);
for (const [kind, names] of [
  ["CONF-04", ["Bun.spawn", "Bun.spawnSync", "Bun.$", "Worker"]],
  ["CONF-03", ["fetch", "Bun.connect", "Bun.listen", "Bun.serve", "WebSocket"]],
  ["CONF-02", ["setTimeout", "setInterval", "setImmediate", "Bun.sleep", "Bun.sleepSync", "Bun.nanoseconds", "Atomics.wait", "Atomics.waitAsync", "Date", "Date.now", "performance.now", "process.hrtime", "process.hrtime.bigint", "process.uptime"]],
  ["CONF-01", ["process.exit"]],
] as const) for (const name of names) {
  const calls: Record<string, string> = { fetch: "saved('http://127.0.0.1:1')", "Bun.spawn": "saved([process.execPath,'-e',''])", setTimeout: "saved(()=>{},0)" };
  probes.push([name, kind, fixture(`const saved=${name}`, calls[name] ?? "saved()")]);
}
probes.push(["new Date", "CONF-02", fixture("const saved=Date", "new saved()")], ["performance.timeOrigin", "CONF-02", fixture("const saved=()=>performance.timeOrigin")]);
for (const method of ["format", "formatToParts"]) probes.push([`Intl.DateTimeFormat.${method}`, "CONF-02", fixture(`const formatter=new Intl.DateTimeFormat(); const saved=()=>formatter.${method}()`)]);
for (const [api, caseId, source] of probes) test(`${api} captured at import is RED on ${caseId}`, async () => {
  const result = await run(source);
  expect(result.stderr).toBe(""); expect(result.code).toBe(1);
  expect(result.report.rows.find((r: { id: string }) => r.id === caseId).result).toBe("fail");
});
test("null report is stable across processes, order, locale, TZ and cwd; snapshot pins it", async () => {
  const a = await run(), b = await run(undefined, { ...process.env, LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", TZ: "Pacific/Kiritimati" }, scratch, ["--reverse"]);
  expect(a.code).toBe(1); expect(b.code).toBe(1); expect(b.stdout).toBe(a.stdout);
  expect(a.stdout).toBe(readFileSync(resolve(import.meta.dir, (process.platform === "darwin" ? "report.macos-sandbox.snapshot.json" : "report.snapshot.json")), "utf8"));
});
test("import stamp is detected by the entry's own two-process comparison", async () => {
  const result = await run(`const stamp=process.pid; export default {name:'stamp',create(){return {send(){},events:(async function*(){yield {stamp}})(),async shutdown(){}}}}`);
  expect(result.code).toBe(1); expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-01").result).toBe("fail");
});
test("within-process nondeterminism is never promoted by equal child reports", async () => {
  const result = await run(`let nonce=0;export default {name:'nonce',create(){const value=++nonce;return {send(){},events:(async function*(){yield {value}})(),async shutdown(){}}}}`);
  expect(result.code).toBe(1); expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-01").result).toBe("fail");
});
test("network and spawn have committed fail-sets, even when caught", async () => {
  for (const [api, expected] of [["fetch", networkFailSet], ["Bun.spawn", spawnFailSet]] as const) {
    const result = await run(fixture(`const saved=${api}`));
    expect(result.report.rows.filter((r: { result: string }) => r.result === "fail").map((r: { id: string }) => r.id)).toEqual(expected);
  }
});
test("in-process callers without preload fail closed, including determinism", async () => {
  const report = await runConformance(binding);
  expect(report.rows.filter(r => r.result === "fail").map(r => r.id)).toEqual(["CONF-01", "CONF-03", "CONF-04", "DET-01", "ERR-01", "GEN-01e", "GEN-02", "ID-03", "ID-04", "LIFE-01e", "LIM-01", "NEG-01", "NEG-02", "NEG-03", "ORDER-01", "PLAN-LAT-01", "TIME-01", "TIME-02", "VER-01", "VER-02e", "WORD-02"]);
  for (const id of ["CONF-03", "CONF-04"]) expect(report.rows.find(r => r.id === id)).toMatchObject({ diagnostic: "traps absent: use the packaged entry" });
});
test("late exit after shutdown cannot overwrite the red exit status", async () => {
  const result = await run(`export default {name:'late',create(){return {send(){},events:(async function*(){})(),async shutdown(){setImmediate(()=>process.exit(0))}}}}`);
  expect(result.code).toBe(1); expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-02").result).toBe("fail");
});
test("entry import has no effects", async () => {
  const proc = Bun.spawn([runtime, "--eval", `await import(${JSON.stringify(entry)});console.log('imported')`], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(proc.stdout).text()).toBe("imported\n"); expect(await proc.exited).toBe(0);
});
test("explicit fixture dates remain usable without a clock violation", async () => {
  const result = await run(fixture("const saved=()=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(new Date(0))"));
  expect(result.code).toBe(1);
  expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-02").result).toBe("pass");
});
test("the mutable flag alone cannot spoof a preload in direct callers", async () => {
  trapState.installed = true;
  try { const report = await runConformance(binding); expect(report.rows.filter(r => r.result === "fail").map(r => r.id)).toEqual(["CONF-01", "CONF-03", "CONF-04", "DET-01", "ERR-01", "GEN-01e", "GEN-02", "ID-03", "ID-04", "LIFE-01e", "LIM-01", "NEG-01", "NEG-02", "NEG-03", "ORDER-01", "PLAN-LAT-01", "TIME-01", "TIME-02", "VER-01", "VER-02e", "WORD-02"]); }
  finally { trapState.installed = false; }
});
