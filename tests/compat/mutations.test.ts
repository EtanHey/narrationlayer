import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { withEnv } from "./harness.js";
import { runMutation, type MutationRow } from "./mutations.js";

async function scratch(run: (cwd: string) => Promise<void>) {
  const parent = path.resolve(import.meta.dir, "../../docs.local/s2b");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "self-test-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
const named = (testName = "named [literal].*"): MutationRow => ({
  kind: "named-test", name: "self", file: "value.ts", before: "value = 1", after: "value = 2",
  testFile: "./fixture.test.ts", testName,
});
async function fixture(cwd: string, body: string) {
  await writeFile(path.join(cwd, "value.ts"), "export const value = 1;\r\n");
  await writeFile(path.join(cwd, "fixture.test.ts"), `import {test,expect} from 'bun:test';\nimport {value} from './value';\n${body}\n`);
}
async function unchanged(cwd: string) {
  expect(await readFile(path.join(cwd, "value.ts"), "utf8")).toBe("export const value = 1;\r\n");
}
test("mutation gate: named test flips and source bytes restore", () => scratch(async cwd => {
  await fixture(cwd, `test('named [literal].*',()=>expect(value).toBe(1));`);
  await runMutation(named(), cwd);
  await unchanged(cwd);
}));
test("mutation gate: hook failure cannot kill the named test", () => scratch(async cwd => {
  // afterAll fails outside the named per-test result, despite the command's nonzero exit.
  await fixture(cwd, `import {afterAll} from 'bun:test';
    test('named [literal].*',()=>expect(true).toBe(true));
    afterAll(()=>expect(value).toBe(1));`);
  await expect(runMutation(named(), cwd)).rejects.toThrow("named test still green");
  await unchanged(cwd);
}));
test("mutation gate: nonexistent named test is rejected", () => scratch(async cwd => {
  await fixture(cwd, `test('different test',()=>expect(value).toBe(1));`);
  await expect(runMutation(named("missing"), cwd)).rejects.toThrow("Named test not found");
  await unchanged(cwd);
}));
test("mutation gate: compile failure does not reach the named test", () => scratch(async cwd => {
  await fixture(cwd, `test('named [literal].*',()=>expect(value).toBe(1));`);
  await expect(runMutation({ ...named(), after: "value = ;" }, cwd)).rejects.toThrow("did not reach the named test");
  await unchanged(cwd);
}));
const conformance = (caseId: string): MutationRow => ({
  kind: "conformance-case", name: "self", file: "value.ts", before: "value = 1", after: "value = 2",
  binding: "./value.ts", caseId,
});
async function conformanceFixture(cwd: string) {
  await fixture(cwd, "");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { conformance: "bun report.ts" } }));
  await writeFile(path.join(cwd, "report.ts"), `import {value} from './value';
    console.log(JSON.stringify({schema:'nl.conformance/1',rows:[
      {id:'CONF-flips',result:value===1?'pass':'fail'}, {id:'CONF-stays',result:'pass'}]}));`);
}
test("mutation gate: named conformance case flips", () => scratch(async cwd => {
  await conformanceFixture(cwd);
  await runMutation(conformance("CONF-flips"), cwd);
  await unchanged(cwd);
}));
test("mutation gate: another conformance case flipping is rejected", () => scratch(async cwd => {
  await conformanceFixture(cwd);
  await expect(runMutation(conformance("CONF-stays"), cwd)).rejects.toThrow("named case still green");
  await unchanged(cwd);
}));
test("mutation gate: missing conformance case is rejected", () => scratch(async cwd => {
  await conformanceFixture(cwd);
  await expect(runMutation(conformance("missing"), cwd)).rejects.toThrow("Conformance case not found");
  await unchanged(cwd);
}));
test("mutation gate: invalid conformance report is rejected", () => scratch(async cwd => {
  await conformanceFixture(cwd);
  await writeFile(path.join(cwd, "report.ts"), "console.log('not JSON');");
  await expect(runMutation(conformance("CONF-flips"), cwd)).rejects.toThrow("cannot be parsed");
  await unchanged(cwd);
}));

for (const marker of ["CLAUDECODE", "AGENT"]) test(`mutation gate: ${marker}=1 preserves named results`, () => scratch(async cwd => {
  await fixture(cwd, `test('named [literal].*',()=>expect(value).toBe(1));`);
  await withEnv({ [marker]: "1" }, () => runMutation(named(), cwd));
  await unchanged(cwd);
}));
test("mutation gate: describe scopes form the full test path", () => scratch(async cwd => {
  await fixture(cwd, `import {describe} from 'bun:test';
    describe('outer',()=>describe('inner',()=>test('a & "xml"',()=>expect(value).toBe(1))));`);
  await runMutation(named('outer inner a & "xml"'), cwd);
}));
test("mutation gate: a real second failing test cannot kill the named test", () => scratch(async cwd => {
  // A second real Bun test fails in a separate invocation, setting this process's exit code.
  await writeFile(path.join(cwd, "other.test.ts"), `import {test,expect} from 'bun:test';import {value} from './value';test('different test',()=>expect(value).toBe(1));`);
  await fixture(cwd, `const other=Bun.spawnSync([process.execPath,'test','./other.test.ts']);
    process.stderr.write(other.stderr);process.exitCode=other.exitCode;
    test('named [literal].*',()=>expect(true).toBe(true));`);
  await expect(runMutation(named(), cwd)).rejects.toThrow("named test still green");
  expect(await readFile(path.join(cwd, "docs.local/characterization/self-mutated.log"), "utf8")).toContain("(fail) different test");
}));
test("mutation gate: skipped named test did not run", () => scratch(async cwd => {
  await fixture(cwd, `(value===1?test:test.skip)('named [literal].*',()=>expect(value).toBe(1));`);
  await expect(runMutation(named(), cwd)).rejects.toThrow("did not reach the named test");
}));
test("mutation gate: duplicate names are ambiguous", () => scratch(async cwd => {
  await fixture(cwd, `for(let i=0;i<2;i++) test('named [literal].*',()=>expect(value).toBe(1));`);
  await expect(runMutation(named(), cwd)).rejects.toThrow("Named test is ambiguous: 2 matches");
}));
for (const body of ["throw new Error('load failure');", "setTimeout(()=>{throw new Error('detached failure')},0);"])
  test(`mutation gate: unrelated failure ${body.slice(0, 10)}`, () => scratch(async cwd => {
    await fixture(cwd, `test('named [literal].*',()=>expect(true).toBe(true)); if(value===2){${body}}`);
    await expect(runMutation(named(), cwd)).rejects.toThrow(body.startsWith("throw") ? "did not reach" : "named test still green");
  }));
test("mutation gate: a near name cannot kill a literal name", () => scratch(async cwd => {
  await fixture(cwd, `test('a (b): c.d+e',()=>expect(true).toBe(true));test('a b: cXdde',()=>expect(value).toBe(1));`);
  await expect(runMutation(named("a (b): c.d+e"), cwd)).rejects.toThrow("named test still green");
}));
test("mutation gate: foo is distinct from foo bar", () => scratch(async cwd => {
  await fixture(cwd, `test('foo',()=>expect(true).toBe(true));test('foo bar',()=>expect(value).toBe(1));`);
  await expect(runMutation(named("foo"), cwd)).rejects.toThrow("named test still green");
}));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(`mutation gate: ${signal} restores the scratch file`, () => scratch(async cwd => {
    const socketPath = path.join(cwd, "ready.sock");
    const ready = Promise.withResolvers<void>();
    const server = createServer(socket => socket.once("data", () => { socket.end(); ready.resolve(); }));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await fixture(cwd, `test('named [literal].*',async()=>{
      await Bun.connect({unix:${JSON.stringify(socketPath)},socket:{open(s){s.write('ready');},data(){},close(){}}});
      await new Promise(()=>{});});`);
    const modulePath = process.env.MUTATION_GATE_MODULE ?? path.join(import.meta.dir, "mutations.ts");
    await writeFile(path.join(cwd, "run.ts"), `import {runMutation} from ${JSON.stringify(modulePath)};await runMutation(${JSON.stringify(named())},process.cwd());`);
    const child = Bun.spawn([process.execPath, "run.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
    const errors = new Response(child.stderr).text();
    const timer = setTimeout(() => ready.reject(new Error("mutation never became ready")), 3000);
    try {
      await Promise.race([ready.promise, child.exited.then(async code => { throw new Error(`gate child exited ${code}: ${await errors}`); })]);
      child.kill(signal);
      expect(await child.exited).not.toBe(0);
      await unchanged(cwd);
    } finally { clearTimeout(timer); child.kill(); server.close(); }
  }));

test("mutation gate: regex metacharacters name a real failure", () => scratch(async cwd => {
  await fixture(cwd, `test('a (b): c.d+e',()=>expect(value).toBe(1));`);
  await runMutation(named("a (b): c.d+e"), cwd);
}));
for (const [attack, script, message] of [
  ["inactive case", `console.log(JSON.stringify({schema:'nl.conformance/1',rows:[{id:'CONF-flips',result:'inactive'}]}));`, "Restored case failed"],
  ["module crash", `throw new Error('module failed');`, "cannot be parsed"],
  ["extra stdout", `console.log('noise');console.log(JSON.stringify({schema:'nl.conformance/1',rows:[{id:'CONF-flips',result:'pass'}]}));`, "cannot be parsed"],
]) test(`mutation gate: conformance rejects ${attack}`, () => scratch(async cwd => {
  await conformanceFixture(cwd);
  await writeFile(path.join(cwd, "report.ts"), script!);
  await expect(runMutation(conformance("CONF-flips"), cwd)).rejects.toThrow(message!);
}));
