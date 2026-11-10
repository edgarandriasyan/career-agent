import type { Msg } from "../../src/types";

/*
 * Judge specs: one binary Pass/Fail judge per failure mode (write-judge-prompt skill). Pure data and
 * types, no node:* or SDK imports, so the Worker can import them.
 */

export type JudgeModel = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";

/** What a judge may see. `context` replaces the corpus for RAG arms. */
export type JudgeInput = { question?: string; history?: Msg[]; reply: string; rubric?: string; context?: string };

export type JudgeSpec = {
  /** The check name and the validation/status.json family key, e.g. "J0_rubric". */
  id: string;
  criterion: string;
  pass: string;
  fail: string;
  /** The only inputs sent to the judge, in this order. */
  inputs: Array<"question" | "history" | "reply" | "rubric">;
  /** Few-shot examples from the train split only. */
  examples: { input: JudgeInput; critique: string; result: "Pass" | "Fail" }[];
};

/** `pass` is null when the judge gave no verdict (refusal, cut off, or output off the schema). */
export type JudgeVerdict = {
  judgeId: string;
  model: JudgeModel;
  promptHash: string;
  pass: boolean | null;
  critique: string;
  error?: "refusal" | "max_tokens" | "invalid";
  costUsd: number;
};
