import { expect, test } from "vitest";
import { smokeLoop } from "./smoke";

test("smokeLoop makes `repeat` calls when the budget allows", async () => {
  let n = 0;
  expect(await smokeLoop(2, 1, async () => (n++, 0.1))).toEqual({ spentUsd: 0.2, calls: 2, stoppedForBudget: false });
  expect(n).toBe(2);
});

test("smokeLoop refuses the next call once spend reaches the budget", async () => {
  let n = 0;
  expect(await smokeLoop(3, 0.1, async () => (n++, 0.1))).toEqual({ spentUsd: 0.1, calls: 1, stoppedForBudget: true });
  expect(n).toBe(1);
});
