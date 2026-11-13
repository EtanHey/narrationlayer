import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
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
test("mutation gate: another test failing cannot kill the named test", () => scratch(async cwd => {
  // afterAll fails outside the named per-test result, despite the command's nonzero exit.
  await fixture(cwd, `import {afterAll} from 'bun:test';
    test('named [literal].*',()=>expect(true).toBe(true));
    afterAll(()=>expect(value).toBe(1));
    test('different test',()=>expect(value).toBe(1));`);
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
