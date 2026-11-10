// Standing spend caps in USD, at the top of each estimate's range so a normal run never stops short.
// `pr`: the PR subset; `full`: the full set with 3 repeats. Revised from costs.json after E10.
export const BUDGETS: Record<"pr" | "full", Record<string, number>> = {
  pr: { "claude-haiku-5-5": 0.5, "claude-sonnet-5-5": 1.5 },
  full: { "claude-haiku-5-5": 3, "claude-sonnet-5-5": 6 },
};
