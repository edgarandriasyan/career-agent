import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { register, trace } from "@arizeai/phoenix-otel";
import { afterAll, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../src/types";
import { buildHeader, writeResults, type ResultsFile } from "../results";
import { runCases, type AgentFn, type LoadedCase } from "../run";
import { codeEvaluators, costEvaluator, judgeEvaluator, type TaskOutput } from "./evaluators";
import { quietLogger, runPhoenixExperiment, type ExperimentDeps, type ExperimentOptions } from "./experiment";
import type { Example, ExperimentRun, RanExperiment, RunExperimentParams } from "./types";

const exporter = new InMemorySpanExporter();
const provider = register({ projectName: "test", spanProcessors: [new SimpleSpanProcessor(exporter)], global: true });
afterAll(() => provider.shutdown());

const mk = (o: Partial<LoadedCase> & { id: string }): LoadedCase => ({ category: "facts", question: "q", isPrivate: false, ...o });
const cases = [mk({ id: "a", mustInclude: ["stub"] }), mk({ id: "b", category: "tone" }), mk({ id: "c" })];
const done = (costUsd: number): AgentEvent => ({ type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd, model: "stub" });
const spyAgent = (costUsd = 0) =>
  vi.fn<AgentFn>(async function* () {
    yield { type: "sentence", text: "A stub reply.", sources: [] };
    yield done(costUsd);
  });
const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), "phoenix-exp-"));
  return { publicDir: join(d, "public"), privateDir: join(d, "private") };
};
const read = (dir: string): ResultsFile => JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));

/** A stand-in for Phoenix: datasets kept in memory, runExperiment shaped like the client's (a Task span per run). */
function fakePhoenix(up = true) {
  const datasets = new Map<string, Example[]>();
  const taskTraceIds: Record<string, string[]> = {};
  const params: RunExperimentParams[] = [];
  const deps: ExperimentDeps = {
    phoenixUp: vi.fn(async () => up),
    createDataset: vi.fn(async (p: { name: string; examples: Example[] }) => {
      datasets.set(p.name, p.examples);
      return { datasetId: p.name };
    }),
    runExperiment: vi.fn(async (p: RunExperimentParams): Promise<RanExperiment> => {
      params.push(p);
      const name = "datasetName" in p.dataset ? p.dataset.datasetName : "";
      const examples = (datasets.get(name) ?? []).filter((e) => !p.dataset.splits || p.dataset.splits.some((s) => (e.splits as string[]).includes(s)));
      const runs: Record<string, ExperimentRun> = {};
      for (const e of examples)
        for (let rep = 1; rep <= (p.repetitions ?? 1); rep++)
          await trace.getTracer("fake").startActiveSpan("Task: task", async (span) => {
            const traceId = span.spanContext().traceId;
            (taskTraceIds[e.id!] ??= []).push(traceId);
            const run: ExperimentRun = { id: `${e.id}-${rep}`, traceId, experimentId: "exp-1", datasetExampleId: e.id!, startTime: new Date(), endTime: new Date(), output: null, error: null };
            try {
              run.output = (await p.task({ ...e, id: e.id!, nodeId: e.id!, updatedAt: new Date() } as Example)) as object;
            } catch (err) {
              run.error = (err as Error).message;
            }
            runs[run.id] = run;
            span.end();
          });
      return { id: "exp-1", datasetId: name, datasetVersionId: "v1", repetitions: p.repetitions ?? 1, metadata: {}, projectName: "p", createdAt: "", updatedAt: "", exampleCount: examples.length, successfulRunCount: 0, failedRunCount: 0, missingRunCount: 0, runs };
    }),
  };
  return { deps, taskTraceIds, params };
}

const opts = (o: Partial<ExperimentOptions>): ExperimentOptions => ({
  cases, dataset: "public", split: "all", repeat: 1, agent: spyAgent(), kind: "stub", judges: [], model: "stub", career: "",
  budgetUsd: 10, name: "test", holdout: new Set(), ...o,
});

test("experiment refuses to start when Phoenix is unreachable", async () => {
  const agent = spyAgent();
  const { deps } = fakePhoenix(false);
  await expect(runPhoenixExperiment(opts({ agent }), { ...deps, dirs: dirs() })).rejects.toThrow(/Phoenix is not reachable/);
  expect(agent).not.toHaveBeenCalled();
  expect(deps.createDataset).not.toHaveBeenCalled();
  expect(deps.runExperiment).not.toHaveBeenCalled();
});

test("each stored run carries the trace id of its task span", async () => {
  const { deps, taskTraceIds } = fakePhoenix();
  const d = dirs();
  const out = await runPhoenixExperiment(opts({ repeat: 2 }), { ...deps, dirs: d });
  const priv = read(d.privateDir);
  expect(priv.header.experimentId).toBe("exp-1");
  expect(priv.runs.map((r) => [r.id, r.rep])).toEqual([["a", 0], ["a", 1], ["b", 0], ["b", 1], ["c", 0], ["c", 1]]);
  for (const r of priv.runs) {
    expect(r.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.traceId).toBe(taskTraceIds[r.id][r.rep]);
  }
  expect(out.runs.map((r) => r.result.traceId)).toEqual(priv.runs.map((r) => r.traceId));
  // The case span is a child of the task span, with GUARDRAIL children of its own.
  const spans = exporter.getFinishedSpans();
  const caseSpan = spans.find((s) => s.name === "case" && s.spanContext().traceId === taskTraceIds.a[0])!;
  expect(caseSpan).toBeDefined();
  expect(spans.some((s) => s.attributes["openinference.span.kind"] === "GUARDRAIL" && s.parentSpanContext?.spanId === caseSpan.spanContext().spanId)).toBe(true);
});

test("experiment stops before the next example once the budget is reached", async () => {
  const agent = spyAgent(0.5);
  const { deps } = fakePhoenix();
  const d = dirs();
  const out = await runPhoenixExperiment(opts({ agent, budgetUsd: 1 }), { ...deps, dirs: d });
  expect(agent).toHaveBeenCalledTimes(2);
  expect(out.stoppedForBudget).toBe(true);
  const priv = read(d.privateDir);
  expect(priv.header).toMatchObject({ stoppedForBudget: true, incomplete: true, costUsd: 1 });
  expect(priv.runs.map((r) => r.id)).toEqual(["a", "b"]);
});

test("private examples get no explanation and the quiet logger prints ids only", async () => {
  const output = (isPrivate: boolean): TaskOutput => ({
    caseId: "x", rep: 0, reply: "r", question: "q", history: [], sentences: [], fallback: null, pass: false, costUsd: 0.1, judgeCostUsd: 0, isPrivate,
    checks: [{ name: "mustInclude#1", pass: false, reason: "required text missing" }, { name: "J0_rubric", pass: false, reason: "CRITIQUE QUOTING THE REPLY" }],
  });
  const mustInclude = codeEvaluators().find((e) => e.name === "mustInclude")!;
  const j0 = judgeEvaluator((await import("../judges/rubric")).J0_RUBRIC, "claude-sonnet-5-5", { career: "" });
  for (const ev of [mustInclude, j0]) {
    const pub = await ev.evaluate({ input: {}, output: output(false), expected: {}, metadata: {} });
    const priv = await ev.evaluate({ input: {}, output: output(true), expected: {}, metadata: {} });
    expect(pub).toMatchObject({ score: 0, label: "fail" });
    expect(pub.explanation).toBeTruthy();
    expect(priv).toMatchObject({ score: 0, label: "fail" });
    expect(priv.explanation).toBeUndefined();
    expect(priv.metadata?.status).toBeDefined();
  }
  expect(await costEvaluator().evaluate({ input: {}, output: output(true), expected: {}, metadata: {} })).toMatchObject({ score: 0.1 });

  const lines: string[] = [];
  const log = quietLogger((l) => lines.push(l));
  log.info("Experiment x (dataset career-agent-private) SECRET");
  log.table({ SECRET: 1 });
  log.error('Error running task "task" on example "conf-01" repetition 1: SECRET case text');
  log.error('Evaluator "J0_rubric" on run "run-7" failed: SECRET');
  expect(lines.join("\n")).not.toContain("SECRET");
  expect(lines).toEqual(["error: task conf-01", "error: J0_rubric run-7"]);

  // A private dataset runs with the quiet logger.
  const { deps, params } = fakePhoenix();
  const printed: string[] = [];
  const priv = [mk({ id: "p1", isPrivate: true, question: "SECRET question", mustInclude: ["SECRET term"] })];
  await runPhoenixExperiment(opts({ dataset: "private", cases: priv }), { ...deps, dirs: dirs(), print: (l) => printed.push(l) });
  expect(printed.join("\n")).toContain("p1");
  expect(printed.join("\n")).not.toContain("SECRET");
  printed.length = 0;
  params[0].logger!.info("SECRET");
  params[0].logger!.error('Error running task "task" on example "p1" repetition 1: SECRET');
  expect(printed).toEqual(["error: task p1"]);
  expect(params[0]).toMatchObject({ concurrency: 1, dataset: { datasetName: "career-agent-private" } });
});

test("experiment writes the same results files as run.ts", async () => {
  const runTs = dirs();
  const out = await runCases(cases, { agent: spyAgent(), model: "stub", career: "", judges: [] });
  const header = buildHeader({
    model: "stub", agent: "stub", startedAt: "t", repeat: 1, only: null, ids: null, judgeSkipped: false, incomplete: false, stoppedForBudget: false,
    costUsd: 0, judgeCostUsd: 0, career: "", cases, judges: [],
  });
  writeResults("s", header, out.runs, () => false, runTs);
  const exp = dirs();
  const { deps } = fakePhoenix();
  await runPhoenixExperiment(opts({}), { ...deps, dirs: exp });

  const norm = (f: ResultsFile) => ({
    header: { ...f.header, startedAt: "", experimentId: undefined },
    runs: f.runs.map((r) => ({ ...r, traceId: null, latencyMs: null })),
  });
  for (const k of ["publicDir", "privateDir"] as const) expect(norm(read(exp[k]))).toEqual(norm(read(runTs[k])));
  expect(Object.keys(read(exp.publicDir).header)).toContain("experimentId");
});
