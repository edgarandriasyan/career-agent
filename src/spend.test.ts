import { expect, test } from "vitest";
import { costUsd } from "./spend";

const M = 1_000_000;

test("Haiku 5.5 rates", () => {
  expect(costUsd("claude-haiku-5-5", { input: M, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.1);
  expect(costUsd("claude-haiku-5-5", { input: 0, output: M, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.5);
  expect(costUsd("claude-haiku-5-5", { input: 0, output: 0, cacheRead: M, cacheWrite: 0 })).toBeCloseTo(0.01);
  expect(costUsd("claude-haiku-5-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: M })).toBeCloseTo(0.125);
});

test("Sonnet 5.5 rates", () => {
  expect(costUsd("claude-sonnet-5-5", { input: M, output: M, cacheRead: M, cacheWrite: M })).toBeCloseTo(2 + 10 + 0.1 + 2.5);
});

test("an unknown model throws instead of guessing", () => {
  expect(() => costUsd("claude-unknown", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toThrow();
});
