import { expect, test } from "bun:test";
import inventory from "./engine-no-wait.json";
import registry from "../../src/engine/conformance/registry.json";

test("engine no-wait inventory names real contract obligations and registry cases", () => {
  expect(inventory.map(row => row.contract_line).sort((a, b) => a - b)).toEqual([331, 425, 426, 427, 427, 428, 429, 430]);
  expect(new Set(inventory.map(row => row.id)).size).toBe(inventory.length);
  for (const row of inventory) {
    expect(Object.keys(row).sort()).toEqual(["case_ids", "contract_line", "evidence", "id", "obligation", "state"]);
    for (const value of [row.id, row.obligation, row.evidence]) expect(value.length).toBeGreaterThan(0);
    expect(["proved", "owed"]).toContain(row.state);
    expect(Array.isArray(row.case_ids)).toBe(true);
    for (const id of row.case_ids) expect(registry.some(entry => entry.id === id), `unknown inventory case ${id}`).toBe(true);
  }
});

test("engine no-wait: synchronous I/O proof is scoped to import reach", () => {
  expect(inventory.filter(row => row.contract_line === 427).map(row => [row.id, row.state])).toEqual([
    ["no-sync-io-engine-reach", "proved"], ["no-sync-io-host-modules", "owed"],
  ]);
});
