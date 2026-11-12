// Pure re-export files are flagged shims; incoming edges use the existing boundary parser and resolver.
// Mixed legacy modules that also declare code remain a review item.
import { expect, test } from "bun:test";
import { LEDGER_PATH, readJson, shimProblems, type Ledger } from "../../scripts/dev/boundaries.js";

const SHIM = "src/shim.ts";
const HOME = "src/home.ts";
const FORWARD = 'export { f } from "./home.js";\nexport type { T } from "./home.js";\nexport * from "./home.js";\n';
const row = { layer: 0, area: "core", owner: "fixture" } as const;
const ledger: Ledger = { layers: {}, files: { [SHIM]: { ...row, shim: true }, [HOME]: row } };
function fixture(files: Record<string, string> = {}, rows: Ledger = ledger) {
  const all: Record<string, string> = { [SHIM]: FORWARD, [HOME]: "export const f = 1; export type T = number;", ...files };
  return shimProblems(rows, { files: Object.keys(all), tracked: new Set(Object.keys(all)), read: (f) => all[f], root: "/checkout" });
}

test("tracked shim shapes and incoming edges obey the rule, outside the layer baseline", () => {
  expect(shimProblems(readJson<Ledger>(LEDGER_PATH))).toEqual([]);
}, 30_000);

test.each([
  'import { f } from "./shim.js";',
  'import type { T } from "./shim.js";',
  'import * as ns from "./shim.js";',
  'const load = import("./shim.js");',
  'export { f } from "./shim.js";',
  'export * from "./shim.js";',
  'type T = import("./shim.js").T;',
  'const ns = require("./shim.js");',
  'import ns = require("./shim.js");',
  'import "/checkout/src/shim.ts";',
  'import "file:///checkout/src/shim.ts";',
  'import { f } from "pkg/shim";',
])("every incoming form names the shim and its targets: %s", (source) => {
  const problems = fixture({ "src/caller.ts": `${source}\nconst keep = 1;`, "package.json": '{"name":"pkg","exports":{"./shim":"./src/shim.ts"}}' });
  expect(problems).toEqual([`src/caller.ts imports shim ${SHIM}; re-exports from ${HOME}`]);
});

test.each(["bin/caller.ts", "scripts/caller.ts", "tests/caller.test.ts", "tests/compatibility/caller.ts", "other/caller.js", "other/caller.mts", "other/caller.cts", "other/caller.tsx", "other/caller.d.ts", "src/api/index.ts"])("incoming edges include tracked sources outside the layer scan: %s", (from) => {
  expect(fixture({ [from]: 'export { f } from "/checkout/src/shim.ts";\nconst keep = 1;' })).toEqual([`${from} imports shim ${SHIM}; re-exports from ${HOME}`]);
});

test("compatibility imports and the public front door's shape remain allowed", () => {
  expect(fixture({ "tests/compat/caller.ts": 'export { f } from "../../src/shim.js";', "src/api/index.ts": 'export { f } from "../home.js";' })).toEqual([]);
  expect(fixture({ [SHIM]: `// comment\n${FORWARD}/* comment */` })).toEqual([]);
  expect(fixture({ "src/api/index.ts": 'export { f } from "../home.js";' }, { ...ledger, files: { ...ledger.files, "src/api/index.ts": { ...row, shim: true } } })).toEqual(["src/api/index.ts is the public front door, not a shim"]);
});

test.each([
  'function copy() {}',
  'import { f } from "./home.js";',
  'import "./home.js";',
  'const x = 1;',
  'type T = number;',
  'console.log("side effect");',
  'export { local };',
])("a flagged shim rejects any other statement: %s", (statement) => {
  const problems = fixture({ [SHIM]: FORWARD + statement });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain(`${SHIM} shim contains`);
  expect(problems[0]).toContain(statement);
});

test("new pure re-exports and removed flags fail; mixed and empty files are not new shims", () => {
  expect(fixture({ "src/new.ts": FORWARD })).toEqual(["src/new.ts is a pure re-export file but has no shim flag"]);
  expect(fixture({}, { ...ledger, files: { ...ledger.files, [SHIM]: row } })).toEqual([`${SHIM} is a pure re-export file but has no shim flag`]);
  expect(fixture({ "bin/mixed.ts": FORWARD + "export const own = 1;", "src/empty.ts": "// comment" })).toEqual([]);
  expect(fixture({ [SHIM]: "// comment" })).toEqual([`${SHIM} shim has no re-export statements`]);
});

test("a shim flag imposes the shape rule even outside src and bin", () => {
  const problems = fixture({ "scripts/shim.ts": "const own = 1;" }, { ...ledger, files: { ...ledger.files, "scripts/shim.ts": { ...row, shim: true } } });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("scripts/shim.ts shim contains");
  expect(problems[0]).toContain("const own = 1;");
});
