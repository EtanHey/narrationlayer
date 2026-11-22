/** Test-only interpreter for exactly the JSON Schema vocabulary emitted by this slice. */
export type S = { type?: string; enum?: unknown[]; const?: unknown; properties?: Record<string, S>; required?: string[]; allOf?: S[]; anyOf?: S[]; oneOf?: S[]; if?: S; then?: S; items?: S; prefixItems?: S[]; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; pattern?: string };
export function valid(s: S, v: unknown): boolean {
  if (s.allOf && !s.allOf.every(x => valid(x, v))) return false;
  if (s.anyOf && !s.anyOf.some(x => valid(x, v))) return false;
  if (s.oneOf && s.oneOf.filter(x => valid(x, v)).length !== 1) return false;
  if (s.if && valid(s.if, v) && s.then && !valid(s.then, v)) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (Object.hasOwn(s, "const") && v !== s.const) return false;
  if (s.type === "string" && typeof v !== "string" || s.type === "boolean" && typeof v !== "boolean") return false;
  if ((s.type === "number" || s.type === "integer") && (typeof v !== "number" || !Number.isFinite(v) || s.type === "integer" && !Number.isInteger(v))) return false;
  if (typeof v === "string" && (s.minLength !== undefined && v.length < s.minLength || s.maxLength !== undefined && v.length > s.maxLength || s.pattern !== undefined && !new RegExp(s.pattern).test(v))) return false;
  if (s.type === "array" && !Array.isArray(v)) return false;
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems || s.maxItems !== undefined && v.length > s.maxItems) return false;
    if (s.items && !v.every(x => valid(s.items!, x))) return false;
    if (s.prefixItems && !s.prefixItems.every((x, i) => valid(x, v[i]))) return false;
  }
  if (s.type === "object" && (!v || typeof v !== "object" || Array.isArray(v))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (s.required?.some(k => !Object.hasOwn(o, k) || o[k] === undefined)) return false;
    if (Object.entries(s.properties ?? {}).some(([k, x]) => Object.hasOwn(o, k) && o[k] !== undefined && !valid(x, o[k]))) return false;
  }
  return true;
}
/** Flatten only the selected variant, preserving the independent schema's own key lists. */
export function shape(s: S, v: unknown): S {
  const choices = s.anyOf ?? s.oneOf;
  const parts = [s, ...(s.allOf ?? []), ...(choices ? [choices.find(x => valid(x, v)) ?? choices[0]] : []), ...(s.if && valid(s.if, v) && s.then ? [s.then] : [])];
  return parts.slice(1).reduce((r, x) => { const a = shape(x, v); return { ...r, ...a, properties: { ...r.properties, ...a.properties }, required: [...new Set([...(r.required ?? []), ...(a.required ?? [])])] }; }, { ...s });
}
export function at(schema: S, value: unknown, path: string): { schema: S; value: unknown; keys: (string | number)[] } {
  const keys: (string | number)[] = [];
  for (const part of path.split(".").slice(1)) {
    const key = part.replace("[]", ""); schema = shape(schema, value).properties?.[key] ?? {}; value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; keys.push(key);
    if (part.endsWith("[]")) { schema = shape(schema, value).items ?? {}; value = Array.isArray(value) ? value[0] : undefined; keys.push(0); }
  }
  return { schema: shape(schema, value), value, keys };
}
