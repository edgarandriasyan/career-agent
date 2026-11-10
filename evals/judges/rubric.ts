import type { JudgeSpec } from "./spec";

/*
 * J0: the per-case rubric judge. It sees only the case's rubric, the reply and the corpus (never the
 * question or the history). It stays `not-a-judge` in validation/status.json until E14 validates it,
 * so its verdicts are advisory. No few-shot examples yet: they must come from labeled train-split
 * traces (E14), never invented.
 */
export const J0_RUBRIC: JudgeSpec = {
  id: "J0_rubric",
  criterion: "Does the reply satisfy the case's rubric (in <rubric>), with every claim about Edgar supported by the corpus?",
  pass: "The reply does what the rubric asks, and every claim it makes about Edgar is supported by a corpus line.",
  fail: "The reply misses or contradicts something the rubric asks for, or makes a claim about Edgar that no corpus line supports.",
  inputs: ["reply", "rubric"],
  examples: [],
};
