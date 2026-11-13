import { builtinModules } from "node:module";
import trappedData from "./inventory-trapped.json";
import excludedData from "./inventory-excluded.json";
import safeData from "./inventory-safe.json";
export type TrapKind = "network" | "spawn" | "worker" | "clock" | "exit";
function kinds(rows: Record<string, unknown>): Record<string, TrapKind> {
  return Object.fromEntries(Object.entries(rows).map(([key, kind]) => {
    if (kind !== "network" && kind !== "spawn" && kind !== "worker" && kind !== "clock" && kind !== "exit") throw new Error(`invalid trap kind: ${key}`);
    return [key, kind];
  }));
}
export const trapped = { bun: kinds(trappedData.bun), modules: kinds(trappedData.modules) };
export const reviewedSafe = safeData;
export const excluded = excludedData;
export function verifyInventory(
  bunKeys = Reflect.ownKeys(Bun).map(String), modules = builtinModules,
  trapTable: { bun: Record<string, string>; modules: Record<string, string> } = trapped,
  safeTable: { bun: Record<string, string>; modules: Record<string, string> } = reviewedSafe,
  excludedTable: { bun: Record<string, string>; modules: Record<string, string> } = excluded,
): void {
  for (const [area, keys] of [["bun", bunKeys], ["modules", modules]] as const) {
    for (const key of keys) {
      const entries = Number(Object.hasOwn(trapTable[area], key)) + Number(Object.hasOwn(safeTable[area], key)) + Number(Object.hasOwn(excludedTable[area], key));
      if (entries !== 1) throw new Error(`inventory ${area}.${key}: expected exactly one TRAPPED, REVIEWED-SAFE or EXCLUDED row`);
    }
  }
}
