import { expect, test } from "bun:test";
import { utterancesV1, breathingV1, type Piece } from "../../src/plan/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const utterancesReturnPieces: Equal<ReturnType<typeof utterancesV1>, Piece[]> = true;
const breathingReturnsPieces: Equal<ReturnType<typeof breathingV1>, Piece[]> = true;
test("both named policies return the shared Piece type", () => {
  expect(utterancesReturnPieces && breathingReturnsPieces).toBe(true);
});
