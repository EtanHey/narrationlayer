import { builtinModules } from "node:module";
import trappedData from "./inventory-trapped.json";
import excludedData from "./inventory-excluded.json";
import safeData from "./inventory-safe.json";
export type TrapKind = "network" | "spawn" | "worker" | "clock" | "exit" | "realm";
function kinds(rows: Record<string, unknown>): Record<string, TrapKind> {
  return Object.fromEntries(Object.entries(rows).map(([key, kind]) => {
    if (kind !== "network" && kind !== "spawn" && kind !== "worker" && kind !== "clock" && kind !== "exit" && kind !== "realm") throw new Error(`invalid trap kind: ${key}`);
    return [key, kind];
  }));
}
export const trapped = { bun: kinds(trappedData.bun), modules: kinds(trappedData.modules), globals: kinds(trappedData.globals) };
export const reviewedSafe = safeData;
export const excluded = excludedData;
export function verifyInventory(
  bunKeys = Reflect.ownKeys(Bun).map(String), modules = [...builtinModules, "node:test", ...(Bun.version === "1.3.11" ? ["bun:main", "bun:app"] : [])],
  trapTable: { bun: Record<string, string>; modules: Record<string, string>; globals: Record<string, string> } = trapped,
  safeTable: { bun: Record<string, string>; modules: Record<string, string>; globals: Record<string, string> } = reviewedSafe,
  excludedTable: { bun: Record<string, string>; modules: Record<string, string>; globals: Record<string, string> } = excluded,
  globalKeys = Reflect.ownKeys(globalThis).map(String),
): void {
  for (const [area, keys] of [["bun", bunKeys], ["modules", modules], ["globals", globalKeys]] as const) {
    for (const key of keys) {
      const entries = Number(Object.hasOwn(trapTable[area], key)) + Number(Object.hasOwn(safeTable[area], key)) + Number(Object.hasOwn(excludedTable[area], key));
      if (entries !== 1) throw new Error(`inventory ${area}.${key}: expected exactly one TRAPPED, REVIEWED-SAFE or EXCLUDED row`);
    }
  }
}
