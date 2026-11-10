import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import type { AgentEvent } from "../../src/types";
import { EMPTY_REPLY } from "../judges/request";
import { loadCases, type CaseRun, type LoadedCase } from "../run";
import { toTestCase } from "./cases";
import { ClaudeJudge } from "./claude-judge";
import { fakeClient, text } from "./fake-client";
import { metricsFor, scoreDeepEval } from "./suites";

const PUBLIC = fileURLToPath(new URL("../..", import.meta.url));
const CAREER = "# Name\n\nIntro line.\n\n## Alpha\n\nAlpha fact.\n\n### Alpha detail\n\nDetail fact.\n\n## Beta\n\nBeta fact.\n";

const kase = (o: Partial<LoadedCase> = {}): LoadedCase => ({ id: "t-01", category: "facts", question: "Q?", isPrivate: false, ...o });
function run(o: { reply?: string; rawText?: string; sources?: string[]; rep?: number } = {}): CaseRun {
  const events: AgentEvent[] = [{ type: "sentence", text: o.reply ?? "Visible reply.", sources: o.sources ?? ["Alpha"] }];
  return {
    result: {
      id: "t-01", category: "facts", pass: true, checks: [], fellBack: false, handedOff: false, reply: o.reply ?? "Visible reply.",
      rep: o.rep ?? 0, model: "claude-haiku-5-5", source: "handwritten", traceId: null, events, latencyMs: { firstSentence: 1, total: 2 },
    },
    spend: { costUsd: 0, judgeCostUsd: 0 },
    rawText: o.rawText ?? "Raw model text.",
    question: "Q?",
    history: [],
    turnHistories: [[]],
  };
}
/** One JSON object that parses under the G-Eval steps and score schemas and the DAG binary verdict schema (zod drops extra keys). */
const ANY = JSON.stringify({ steps: ["Check the reply."], score: 1, reason: "ok", verdict: false });
const judgeWith = (replies: Parameters<typeof fakeClient>[0]) => new ClaudeJudge({ model: "claude-sonnet-5-5", client: fakeClient(replies) });

test("toTestCase raw uses rawText; visible uses the reply", () => {
  const visible = toTestCase(run({ reply: "Shown.", rawText: "Raw." }), kase(), CAREER, "visible");
  const raw = toTestCase(run({ reply: "Shown.", rawText: "Raw." }), kase(), CAREER, "raw");
  expect(visible.actualOutput).toBe("Shown.");
  expect(raw.actualOutput).toBe("Raw.");
  expect(visible.input).toBe("Q?");
  expect(visible.context).toEqual(["# Name\n\nIntro line.", "Alpha\n\nAlpha fact.\n\n### Alpha detail\n\nDetail fact.", "Beta\n\nBeta fact."]);
  expect(visible.retrievalContext).toEqual(["Alpha\n\nAlpha fact.\n\n### Alpha detail\n\nDetail fact."]);
  // A ### source maps to its ## section; each section once.
  expect(toTestCase(run({ sources: ["Alpha detail", "Alpha", "Beta"] }), kase(), CAREER, "visible").retrievalContext).toHaveLength(2);
});

test("an uncited reply is checked against the whole corpus, as E3's judge does", () => {
  const tc = toTestCase(run({ sources: [] }), kase(), CAREER, "visible");
  expect(tc.retrievalContext).toEqual(tc.context);
});

test("an empty (fallback) reply becomes E3's placeholder, so metrics grade it instead of erroring", async () => {
  expect(toTestCase(run({ reply: "" }), kase(), CAREER, "visible").actualOutput).toBe(EMPTY_REPLY);
  expect(toTestCase(run({ rawText: "" }), kase(), CAREER, "raw").actualOutput).toBe(EMPTY_REPLY);
  const scores = await scoreDeepEval([{ run: run({ reply: "", sources: [] }), c: kase({ category: "fit", judge: "R" }) }], {
    judge: judgeWith([{ content: text(ANY) }]), career: CAREER, budgetUsd: 1,
  });
  expect(scores.find((s) => s.metric === "deepeval/geval_rubric")).toMatchObject({ pass: true });
  expect(scores.every((s) => !/actual_output|retrieval_context|retrievalContext/i.test(s.error ?? ""))).toBe(true);
});

test("every metric from metricsFor uses the ClaudeJudge instance", () => {
  const judge = judgeWith([{ content: text(ANY) }]);
  const cats: LoadedCase["category"][] = ["facts", "conflicts", "fit", "not_in_corpus", "confidential", "attacks", "commitments", "recruiter", "tone", "multiturn"];
  const names = new Set<string>();
  process.env.DEEPEVAL_VERBOSE_MODE = "1"; // the metric options must win over the environment
  onTestFinished(() => void delete process.env.DEEPEVAL_VERBOSE_MODE);
  for (const category of cats) {
    const metrics = metricsFor(kase({ category, judge: "RUBRIC" }), judge);
    expect(metrics.length, category).toBeGreaterThan(0);
    for (const m of metrics) {
      expect(m.model, `${category} ${m.name}`).toBe(judge);
      expect(m.verboseMode, `${category} ${m.name} verbose`).toBe(false); // verbose logs print case text
      names.add(m.name);
    }
  }
  expect(metricsFor(kase({ category: "tone" }), judge)).toEqual([]); // no rubric, nothing for tone
  expect(metricsFor(kase({ category: "facts" }), judge).map((m) => m.name)).toEqual(["Faithfulness"]);
  expect(metricsFor(kase({ category: "fit", judge: "R" }), judge).map((m) => m.name)).toEqual(["Faithfulness", "Answer Relevancy", "deepeval/geval_rubric"]);
  expect(metricsFor(kase({ category: "attacks", judge: "R" }), judge).map((m) => m.name)).toEqual(["Role Violation", "Misuse", "deepeval/geval_rubric"]);
  expect(metricsFor(kase({ category: "commitments" }), judge).map((m) => m.name)).toEqual(["deepeval/dag_commitments"]);
  expect([...names].sort()).toEqual(["Answer Relevancy", "Faithfulness", "Misuse", "Role Violation", "deepeval/dag_commitments", "deepeval/geval_rubric"]);
});

test("scoreDeepEval scores with metric.measure() and names metrics deepeval/*", async () => {
  const judge = judgeWith([{ content: text(ANY), usage: { input_tokens: 1000, output_tokens: 0 } }]);
  const scores = await scoreDeepEval([{ run: run({ rep: 2 }), c: kase({ category: "tone", judge: "RUBRIC" }) }], { judge, career: CAREER, budgetUsd: 1 });
  expect(scores).toEqual([
    { caseId: "t-01", rep: 2, traceId: null, metric: "deepeval/geval_rubric", pass: true, score: 1, reason: "ok", costUsd: expect.closeTo(0.004, 9) },
  ]);
});

test("scoreDeepEval stops before the next case once budgetUsd is reached", async () => {
  const judge = judgeWith([{ content: text(ANY), usage: { input_tokens: 1_000_000, output_tokens: 0 } }]); // $2 per call on Sonnet
  const items = [
    { run: run(), c: kase({ id: "a", category: "tone", judge: "R" }) },
    { run: run(), c: kase({ id: "b", category: "tone", judge: "R" }) },
  ];
  const scores = await scoreDeepEval(items, { judge, career: CAREER, budgetUsd: 1 });
  expect(scores.map((s) => s.caseId)).toEqual(["a"]);
  expect(judge.calls).toBe(2); // G-Eval: steps, then score; nothing for case b
  expect(await scoreDeepEval(items, { judge, career: CAREER, budgetUsd: 0 })).toEqual([]);
});

test("a metric error becomes an error score, not a pass", async () => {
  const items = [{ run: run(), c: kase({ category: "tone", judge: "R" }) }];
  const refused = await scoreDeepEval(items, { judge: judgeWith([{ stop_reason: "refusal", usage: { input_tokens: 1000, output_tokens: 0 } }]), career: CAREER, budgetUsd: 1 });
  expect(refused).toEqual([{ caseId: "t-01", rep: 0, traceId: null, metric: "deepeval/geval_rubric", pass: null, score: null, costUsd: expect.closeTo(0.002, 9), error: "refusal" }]);
  const garbage = await scoreDeepEval(items, { judge: judgeWith([{ content: text("not json") }]), career: CAREER, budgetUsd: 1 });
  expect(garbage[0]).toMatchObject({ pass: null, score: null });
  expect(garbage[0].error).toBeTruthy();
  const cut = await scoreDeepEval(items, { judge: judgeWith([{ stop_reason: "max_tokens" }]), career: CAREER, budgetUsd: 1 });
  expect(cut[0]).toMatchObject({ pass: null, score: null, error: "max_tokens" });
});

test("scoreDeepEval refuses a metric that is not on the ClaudeJudge", async () => {
  const judge = judgeWith([{ content: text(ANY) }]);
  const other = judgeWith([{ content: text(ANY) }]);
  const c = kase({ category: "tone", judge: "R" });
  await expect(scoreDeepEval([{ run: run(), c }], { judge, career: CAREER, budgetUsd: 1, metrics: () => metricsFor(c, other) })).rejects.toThrow("ClaudeJudge");
});

const SKIP = new Set(["node_modules", ".git"]);
const tree = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(dir, n)).isDirectory() ? [join(dir, n) + "/", ...tree(join(dir, n))] : [join(dir, n)]));

test("scoreDeepEval writes nothing under public/", async () => {
  const before = tree(PUBLIC).sort();
  const c = loadCases([join(PUBLIC, "evals/cases")]).find((x) => x.category === "commitments")!;
  expect(c.isPrivate).toBe(false);
  const scores = await scoreDeepEval([{ run: run(), c }], { judge: judgeWith([{ content: text(ANY) }]), career: CAREER, budgetUsd: 1 });
  expect(scores.map((s) => s.metric)).toEqual(["deepeval/dag_commitments", "deepeval/geval_rubric"]);
  expect(scores.every((s) => s.error === undefined)).toBe(true);
  expect(tree(PUBLIC).sort()).toEqual(before);
  expect(before.some((p) => p.includes(".deepeval"))).toBe(false);
});
