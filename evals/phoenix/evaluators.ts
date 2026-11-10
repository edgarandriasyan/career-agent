import { readFileSync } from "node:fs";
import type { CheckResult, FallbackReason, Msg } from "../../src/types";
import { checkFamily } from "../checks";
import { defaultJudgeClient, runJudge, type JudgeClient } from "../judge";
import type { JudgeModel, JudgeSpec } from "../judges/spec";
import type { CaseRun, LoadedCase } from "../run";
import type { EvaluatorStatus } from "../score";
import type { EvaluationResult, Evaluator } from "./types";

/*
 * Phoenix experiment evaluators (phoenix-review.md 4.4). Each returns { score, label, explanation,
 * metadata: { status } }, status from validation/status.json ("advisory" when unlisted): only `code`
 * and `validated` may gate, and gates are decided by run.ts and score.ts, never here.
 *  - codeEvaluators(): one CODE evaluator per code-check family, read from the task output's checks.
 *  - costEvaluator(): spend.ts's agent cost for the run (Phoenix's own estimate under-counts blocked replies).
 *  - judgeEvaluator(): an LLM judge; reuses the verdict the task already paid for, else one paid call.
 *  - deepevalEvaluator(): one DeepEval metric on the ClaudeJudge (paid), advisory until validated.
 * Explanations (check reasons, critiques) are omitted for private examples. Paid evaluators stop
 * before their next call once the shared budget is spent, with an error naming no case text.
 */

/** What the experiment task returns per run (phoenix/experiment.ts); never the raw model text. */
export type TaskOutput = {
  caseId: string;
  rep: number;
  reply: string;
  /** The last turn's question and history (the judge's view of a multi-turn case). */
  question: string;
  history: Msg[];
  sentences: { text: string; sources: string[] }[];
  fallback: { reason: FallbackReason; detail?: string } | null;
  checks: CheckResult[];
  pass: boolean;
  costUsd: number;
  judgeCostUsd: number;
  isPrivate: boolean;
};
export type Budget = { limitUsd: number; spentUsd: number };
type Params = Parameters<Evaluator["evaluate"]>[0];

const STATUS: EvaluatorStatus = JSON.parse(readFileSync(new URL("../validation/status.json", import.meta.url), "utf8"));
const statusOf = (name: string) => STATUS[name]?.status ?? "advisory";
const NA = (name: string): EvaluationResult => ({ score: null, label: "n/a", metadata: { status: statusOf(name) } });

function outputOf(p: Params): TaskOutput {
  if (!p.output || typeof p.output !== "object") throw new Error("run has no output");
  return p.output as TaskOutput;
}
const verdict = (name: string, pass: boolean, explanation: string | undefined, o: TaskOutput, extra: Record<string, unknown> = {}): EvaluationResult => ({
  score: pass ? 1 : 0,
  label: pass ? "pass" : "fail",
  ...(explanation && !o.isPrivate ? { explanation } : {}),
  metadata: { status: statusOf(name), ...extra },
});
function spendGuard(b: Budget) {
  if (b.spentUsd >= b.limitUsd) throw new Error("stopped for budget");
}

export function codeEvaluators(): Evaluator[] {
  return Object.keys(STATUS)
    .filter((family) => STATUS[family].status === "code")
    .map((family) => ({
      name: family,
      kind: "CODE",
      evaluate: (p) => {
        const o = outputOf(p);
        const ks = o.checks.filter((k) => checkFamily(k.name) === family);
        if (!ks.length) return NA(family);
        const failed = ks.filter((k) => !k.pass);
        return verdict(family, !failed.length, failed.map((k) => `${k.name}: ${k.reason ?? ""}`).join("; ") || undefined, o, {
          advisory: ks.every((k) => k.advisory),
        });
      },
    }));
}

export function costEvaluator(): Evaluator {
  return {
    name: "cost_usd",
    kind: "CODE",
    evaluate: (p) => ({ score: outputOf(p).costUsd, metadata: { status: "code" } }),
  };
}

export function judgeEvaluator(
  spec: JudgeSpec,
  model: JudgeModel,
  deps: { career: string; client?: JudgeClient; budget?: Budget },
): Evaluator {
  return {
    name: spec.id,
    kind: "LLM",
    evaluate: async (p) => {
      const o = outputOf(p);
      const done = o.checks.find((k) => k.name === spec.id);
      if (done) {
        const error = done.reason?.startsWith("judge error") ? done.reason : undefined;
        return error ? { score: null, label: "error", metadata: { status: statusOf(spec.id), error } } : verdict(spec.id, done.pass, done.reason, o);
      }
      const rubric = (p.expected as { rubric?: string | null } | undefined)?.rubric;
      if (!rubric) return NA(spec.id);
      const budget = deps.budget ?? { limitUsd: 0, spentUsd: 0 };
      spendGuard(budget);
      const v = await runJudge(spec, { reply: o.reply, rubric, question: o.question, history: o.history }, {
        client: deps.client ?? defaultJudgeClient(),
        model,
        corpus: deps.career,
      });
      budget.spentUsd += v.costUsd;
      const extra = { model, promptHash: v.promptHash, costUsd: +v.costUsd.toFixed(6) };
      if (v.error || v.pass === null) return { score: null, label: "error", metadata: { status: statusOf(spec.id), error: v.error ?? "invalid", ...extra } };
      return verdict(spec.id, v.pass, v.critique, o, extra);
    },
  };
}

/** metric is a DeepEval score name such as "deepeval/faithfulness" (see deepeval/suites.ts). */
export function deepevalEvaluator(metric: string, deps: { career: string; budget: Budget; model?: JudgeModel }): Evaluator {
  return {
    name: metric,
    kind: "LLM",
    evaluate: async (p) => {
      const o = outputOf(p);
      // Loaded on first use: importing DeepEval sets and asserts its environment (deepeval/env.ts).
      const [{ metricsFor, scoreDeepEval, scoreName }, { ClaudeJudge }] = await Promise.all([import("../deepeval/suites"), import("../deepeval/claude-judge")]);
      const expected = (p.expected ?? {}) as { mustInclude?: string[]; mustNotInclude?: string[]; rubric?: string | null };
      const c: LoadedCase = {
        id: o.caseId,
        category: (p.metadata as { category: LoadedCase["category"] }).category,
        question: o.question,
        history: o.history,
        mustInclude: expected.mustInclude,
        mustNotInclude: expected.mustNotInclude,
        judge: expected.rubric ?? undefined,
        isPrivate: o.isPrivate,
      };
      const judge = new ClaudeJudge({ model: deps.model ?? "claude-sonnet-5-5" });
      if (!metricsFor(c, judge).some((m) => scoreName(m) === metric)) return NA(metric);
      spendGuard(deps.budget);
      const run = {
        result: { reply: o.reply, rep: o.rep, traceId: p.traceId ?? null, events: o.sentences.map((s) => ({ type: "sentence" as const, ...s })) },
        question: o.question,
        rawText: "",
      } as unknown as CaseRun;
      const [s] = await scoreDeepEval([{ run, c }], {
        judge, career: deps.career, budgetUsd: Infinity, metrics: (cc, j) => metricsFor(cc, j).filter((m) => scoreName(m) === metric),
      });
      deps.budget.spentUsd += s.costUsd;
      const extra = { costUsd: +s.costUsd.toFixed(6), score: s.score };
      if (s.pass === null) return { score: null, label: "error", metadata: { status: statusOf(metric), error: o.isPrivate ? "error" : s.error, ...extra } };
      return { ...verdict(metric, s.pass, s.reason, o, extra), score: s.score };
    },
  };
}
