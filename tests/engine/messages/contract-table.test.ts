import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import table from "./contract-table.json";
import fixtures from "./fixtures.json";
import { at, shape, valid, type S } from "./schema-check";
import { parseEvent, parseRequest } from "../../../src/engine/messages/parser";
const receive = (direction: string, v: unknown) => direction === "event" ? parseEvent(v) : parseRequest(v);
const schemas = Object.fromEntries(["request", "event"].map(d => [d, JSON.parse(readFileSync(new URL(`../../../src/engine/messages/${d}s.schema.json`, import.meta.url), "utf8")) as S]));
const entries: Record<string, { line: number; objects: Record<string, { line: number; required: string[]; optional: string[] }>; enums: Record<string, unknown[]>; union_enums?: Record<string, (unknown[] | null)[]>; alternatives?: Record<string, { required: string[]; optional: string[] }[]> }> = table.messages;
for (const f of fixtures) {
  test(`independent contract ${f.name}: keys, enums, deletions and wrong type`, () => {
    const entry = entries[f.name]; expect(entry.line).toBeGreaterThan(0);
    const schema = schemas[f.direction].anyOf!.find(s => shape(s, f.valid).properties?.type?.enum?.includes(f.valid.type)); if (!schema) throw Error(f.name);
    expect(valid(schemas[f.direction], f.valid)).toBe(true); expect(valid(schemas[f.direction], f.invalid)).toBe(false);
    for (const [path, row] of Object.entries(entry.objects)) {
      const node = at(schema, f.valid, path);
      expect([...(node.schema.required ?? [])].sort()).toEqual([...row.required].sort());
      expect(Object.keys(node.schema.properties ?? {}).sort()).toEqual([...row.required, ...row.optional].sort());
      for (const [keys, required] of [[row.required, true], [row.optional, false]] as const) for (const key of keys) {
        const copy = structuredClone(f.valid), target = at(schema, copy, path).value;
        if (!target || typeof target !== "object") throw Error(`Missing synthetic object ${f.name} ${path}`);
        delete (target as Record<string, unknown>)[key];
        const result = receive(f.direction, copy); expect(result.ok).toBe(!required); expect(valid(schemas[f.direction], copy)).toBe(!required);
        if (required && !result.ok) expect(result.error.path).toBe(`${path.replaceAll("[]", "[0]")}.${key}`);
      }
    }
    for (const [path, values] of Object.entries(entry.enums)) expect(at(schema, f.valid, path).schema.enum).toEqual(values);
    for (const [path, alternatives] of Object.entries(entry.alternatives ?? {})) expect(at(schema, f.valid, path).schema.oneOf?.map(s => ({ required: s.required ?? [], optional: Object.keys(s.properties ?? {}).filter(k => !s.required?.includes(k)) }))).toEqual(alternatives);
    for (const [path, expected] of Object.entries(entry.union_enums ?? {})) expect(at(schema, f.valid, path).schema.anyOf?.map(s => s.enum ?? null)).toEqual(expected);
    const wrong = { ...f.valid, [f.missing]: typeof (f.valid as Record<string, unknown>)[f.missing] === "number" ? "wrong" : 42 };
    expect(receive(f.direction, wrong)).toMatchObject({ ok: false, error: { path: `$.${f.missing}` } }); expect(valid(schemas[f.direction], wrong)).toBe(false);
  });
}
test("independent table covers exactly the fixture variants", () => expect(Object.keys(entries).sort()).toEqual(fixtures.map(f => f.name).sort()));
test("hello audible condition agrees between emitted schema and parser", () => {
  const hello = fixtures.find(f => f.name === "hello")!.valid;
  for (const binding of ["in-process", "process"]) { const v = { ...hello, binding, audible: true }; expect(valid(schemas.request, v)).toBe(binding === "process"); expect(parseRequest(v).ok).toBe(valid(schemas.request, v)); }
});
