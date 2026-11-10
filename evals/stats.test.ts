import { expect, test } from "vitest";
import { bootstrapCI, clopperPearson, roganGladen, tprTnr, upperBound } from "./stats";

test("clopperPearson 0/10 upper", () => expect(clopperPearson(0, 10).hi).toBeCloseTo(0.3085, 3));
test("clopperPearson known two-sided values", () => {
  // 5/10: [0.1871, 0.8129]; 10/10: [0.6915, 1]
  const mid = clopperPearson(5, 10);
  expect(mid.lo).toBeCloseTo(0.1871, 3);
  expect(mid.hi).toBeCloseTo(0.8129, 3);
  expect(clopperPearson(10, 10)).toEqual({ lo: expect.closeTo(0.6915, 3), hi: 1 });
  expect(clopperPearson(0, 10).lo).toBe(0);
  expect(clopperPearson(0, 0)).toEqual({ lo: 0, hi: 1 });
});
test("upperBound 0 failures: n 59 below 5%, n 58 above", () => {
  expect(upperBound(0, 59)).toBeLessThan(0.05);
  expect(upperBound(0, 58)).toBeGreaterThan(0.05);
  expect(upperBound(0, 59)).toBeCloseTo(0.0495, 4);
});
test("upperBound 1 failure: n 95 below 5%, n 90 above", () => {
  expect(upperBound(1, 95)).toBeLessThan(0.05);
  expect(upperBound(1, 90)).toBeGreaterThan(0.05);
  expect(upperBound(1, 93)).toBeCloseTo(0.04999, 4);
  expect(upperBound(1, 93)).toBeLessThan(0.05);
});
test("roganGladen reproduces the course example", () => expect(roganGladen(0.8, 0.92, 0.88)).toBeCloseTo(0.85, 6));
test("roganGladen clips to [0, 1]", () => {
  expect(roganGladen(0.05, 0.9, 0.9)).toBe(0);
  expect(roganGladen(0.99, 0.9, 0.9)).toBe(1);
});

// 50 human Pass (46 judged Pass), 50 human Fail (44 judged Fail): TPR 0.92, TNR 0.88.
const human = [...Array(50).fill(true), ...Array(50).fill(false)];
const judged = [...Array(46).fill(true), ...Array(4).fill(false), ...Array(44).fill(false), ...Array(6).fill(true)];

test("a judge no better than chance throws instead of returning NaN", () => {
  expect(() => roganGladen(0.5, 0.6, 0.4)).toThrow("judge no better than chance");
  expect(() => bootstrapCI([true, true], [true, true], 0.5, { seed: 1, iters: 50 })).toThrow("judge no better than chance");
});
test("tprTnr treats Pass as positive", () =>
  expect(tprTnr(human, judged)).toEqual({ tpr: 0.92, tnr: 0.88, tp: 46, fn: 4, tn: 44, fp: 6 }));
test("bootstrapCI is seed-stable and contains the point estimate", () => {
  const a = bootstrapCI(human, judged, 0.8, { seed: 7 });
  expect(bootstrapCI(human, judged, 0.8, { seed: 7 })).toEqual(a);
  expect(bootstrapCI(human, judged, 0.8, { seed: 8 })).not.toEqual(a);
  expect(a.lo).toBeLessThan(0.85);
  expect(a.hi).toBeGreaterThan(0.85);
  expect(a.lo).toBeGreaterThan(0.6);
  expect(a.hi).toBeLessThanOrEqual(1);
});
