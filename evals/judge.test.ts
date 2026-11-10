import { expect, test } from "vitest";
import { runJudge, type JudgeClient } from "./judge";
import { JUDGES } from "./judges";
import { judgePromptHash, type JudgeRequest, type JudgeResponse } from "./judges/request";
import { J0_RUBRIC } from "./judges/rubric";

const fake = (r: Partial<JudgeResponse>, seen: JudgeRequest[] = []): JudgeClient => ({
  messages: {
    create: async (p) => {
      seen.push(p);
      return { stop_reason: "end_turn", content: [], ...r };
    },
  },
});
const verdict = (critique: string, result: string) => [{ type: "text", text: JSON.stringify({ critique, result }) }];

test("J0_rubric is registered and sees the reply and rubric only", () => {
  expect(JUDGES.J0_rubric).toBe(J0_RUBRIC);
  expect(J0_RUBRIC.id).toBe("J0_rubric");
  expect(J0_RUBRIC.inputs).toEqual(["reply", "rubric"]);
});

test("runJudge sends one request built from the spec and returns the verdict with its prompt hash and cost", async () => {
  const seen: JudgeRequest[] = [];
  const client = fake(
    {
      content: verdict('The reply says "led a team of 5"; career.md line "Led a team of five" supports it.', "Pass"),
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    seen,
  );
  const v = await runJudge(J0_RUBRIC, { question: "SECRET-QUESTION", reply: "REPLY-TEXT", rubric: "RUBRIC-TEXT" }, { client, model: "claude-sonnet-5-5", corpus: "CORPUS-TEXT" });
  expect(seen).toHaveLength(1);
  expect(seen[0].model).toBe("claude-sonnet-5-5");
  expect(JSON.stringify(seen[0])).not.toContain("SECRET-QUESTION");
  expect(v).toMatchObject({ judgeId: "J0_rubric", model: "claude-sonnet-5-5", pass: true, promptHash: await judgePromptHash(J0_RUBRIC) });
  expect(v.critique).toContain("led a team of 5");
  expect(v.error).toBeUndefined();
  expect(v.costUsd).toBeCloseTo(2);
});

test("runJudge reports a refusal as an error with its cost, never a Pass", async () => {
  const client = fake({ stop_reason: "refusal", content: verdict("x", "Pass"), usage: { input_tokens: 0, output_tokens: 1_000_000 } });
  const v = await runJudge(J0_RUBRIC, { reply: "r", rubric: "x" }, { client, model: "claude-haiku-5-5", corpus: "c" });
  expect(v).toMatchObject({ pass: null, error: "refusal" });
  expect(v.costUsd).toBeCloseTo(0.5);
});

test("runJudge without usage costs zero", async () => {
  const v = await runJudge(J0_RUBRIC, { reply: "r", rubric: "x" }, { client: fake({ content: verdict("c", "Fail") }), model: "claude-opus-5-5", corpus: "c" });
  expect(v).toMatchObject({ pass: false, costUsd: 0 });
});
