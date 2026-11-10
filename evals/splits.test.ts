import { expect, test } from "vitest";
import { mulberry32, stratifiedSplit } from "./splits";

const items = [
  ...Array.from({ length: 17 }, (_, i) => ({ id: `a${i}`, cat: "a" })),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, cat: "b" })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, cat: "c" })),
];
const fractions = [0.2, 0.4, 0.4];

test("mulberry32 is deterministic and in [0, 1)", () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  const xs = Array.from({ length: 5 }, () => a());
  expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
  for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
});
test("stratifiedSplit keeps each category's share within one item and is seed-stable", () => {
  const parts = stratifiedSplit(items, (t) => t.cat, fractions, 42);
  expect(parts).toHaveLength(3);
  expect(parts.flat().map((t) => t.id).sort()).toEqual(items.map((t) => t.id).sort());
  for (const cat of ["a", "b", "c"]) {
    const total = items.filter((t) => t.cat === cat).length;
    parts.forEach((p, j) => expect(Math.abs(p.filter((t) => t.cat === cat).length - fractions[j] * total)).toBeLessThan(1));
  }
  expect(stratifiedSplit(items, (t) => t.cat, fractions, 42)).toEqual(parts);
  expect(stratifiedSplit(items, (t) => t.cat, fractions, 43)).not.toEqual(parts);
});
