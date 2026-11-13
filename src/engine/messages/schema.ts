/** Small dependency-free JSON Schema vocabulary; decoders strip unknown object fields. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class InvalidField extends Error { constructor(readonly path: string) { super("Invalid wire field"); } }
export type Schema<T> = { json: { [key: string]: Json }; read(value: unknown, path: string): T };
export type Value<S> = S extends Schema<infer T> ? T : never;
export const string: Schema<string> = { json: { type: "string" }, read(v, p) { if (typeof v !== "string") throw new InvalidField(p); return v; } };
export const number: Schema<number> = { json: { type: "number" }, read(v, p) { if (typeof v !== "number" || !Number.isFinite(v)) throw new InvalidField(p); return v; } };
export const integer: Schema<number> = { json: { type: "integer" }, read(v, p) { const n = number.read(v, p); if (!Number.isInteger(n)) throw new InvalidField(p); return n; } };
export const boolean: Schema<boolean> = { json: { type: "boolean" }, read(v, p) { if (typeof v !== "boolean") throw new InvalidField(p); return v; } };
export function literal<const T extends string | number | boolean | null>(...values: T[]): Schema<T> {
  return { json: { enum: values }, read(v, p) { for (const x of values) if (v === x) return x; throw new InvalidField(p); } };
}
export function array<T>(item: Schema<T>): Schema<T[]> {
  return { json: { type: "array", items: item.json }, read(v, p) { if (!Array.isArray(v)) throw new InvalidField(p); return Array.from(v, (x, i) => item.read(x, `${p}[${i}]`)); } };
}
export function union<const S extends readonly Schema<unknown>[]>(...schemas: S): Schema<Value<S[number]>> {
  return { json: { anyOf: schemas.map(s => s.json) }, read(v, p) { let deepest = new InvalidField(p); for (const s of schemas) { try { return s.read(v, p) as Value<S[number]>; } catch (e) { if (!(e instanceof InvalidField)) throw e; if (e.path.length > deepest.path.length) deepest = e; } } throw deepest; } };
}
export function object<R extends Record<string, Schema<unknown>>, O extends Record<string, Schema<unknown>> = Record<never, never>>(required: R, optional?: O): Schema<{ [K in keyof R]: Value<R[K]> } & { [K in keyof O]?: Value<O[K]> }> {
  return { json: { type: "object", properties: Object.fromEntries(Object.entries({ ...required, ...optional }).map(([k, s]) => [k, s.json])), required: Object.keys(required), additionalProperties: true }, read(v, p) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new InvalidField(p);
    const input = v as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const [key, s] of Object.entries(required)) result[key] = s.read(Object.hasOwn(input, key) ? input[key] : undefined, `${p}.${key}`);
    for (const [key, s] of Object.entries(optional ?? {})) if (Object.hasOwn(input, key)) result[key] = s.read(input[key], `${p}.${key}`);
    return result as { [K in keyof R]: Value<R[K]> } & { [K in keyof O]?: Value<O[K]> };
  } };
}
/** Only JSON is admitted, including in contract fields whose inner shape is unspecified. */
export const json: Schema<Json> = { json: {}, read(v, p) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return number.read(v, p);
  if (Array.isArray(v)) return Array.from(v, (x, i) => json.read(x, `${p}[${i}]`));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, json.read(x, `${p}.${k}`)]));
  throw new InvalidField(p);
} };
export const offsetRange: Schema<[number, number]> = { json: { type: "array", prefixItems: [integer.json, integer.json], minItems: 2, maxItems: 2 }, read(v, p) { if (!Array.isArray(v) || v.length !== 2) throw new InvalidField(p); return [integer.read(v[0], `${p}[0]`), integer.read(v[1], `${p}[1]`)]; } };
export function boundedString(minLength: number, maxLength: number): Schema<string> { return { json: { type: "string", minLength, maxLength }, read(v, p) { const text = string.read(v, p); if (text.length < minLength || text.length > maxLength) throw new InvalidField(p); return text; } }; }
export const profileRate: Schema<string> = { json: { type: "string", pattern: "^[+-][0-9]+%$" }, read(v, p) { const text = string.read(v, p); if (!/^[+-][0-9]+%$/.test(text)) throw new InvalidField(p); return text; } };
