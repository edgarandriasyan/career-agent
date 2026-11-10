import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { evaluateExperiment, getExperiment, runExperiment } from "@arizeai/phoenix-client/experiments";
import { context, register, trace } from "@arizeai/phoenix-otel";
import type { JudgeClient } from "../judge";
import { JUDGES } from "../judges";
import { buildHeader, writeResults } from "../results";
import {
  formatRun, gateSummary, judgeHeaders, judgesFor, loadCases, resolveAgent, runCase,
  type AgentFn, type CaseRun, type GateJudge, type LoadedCase,
} from "../run";
import { gates, type EvaluatorStatus } from "../score";
import { DATASETS, loadHoldout, PRIVATE_CASES, PUBLIC_CASES, toExample, type CreateDataset } from "./datasets";
import { PHOENIX_URL, phoenixUp, usePhoenixEnv } from "./env";
import { codeEvaluators, costEvaluator, deepevalEvaluator, judgeEvaluator, type Budget, type TaskOutput } from "./evaluators";
import { activeTraceId, caseSpanAttributes, recordGuardrails, withCaseSpan } from "./trace";
import type { Evaluator, Example, Logger, RanExperiment, RunExperimentParams } from "./types";

/*
 * Phoenix experiments: the same runCase as run.ts, recorded in the local Phoenix (phoenix-review.md
 * 3.2 and 3.5). run.ts stays the CI gate with no Phoenix dependency; this front end adds traces,
 * dataset versions, evaluator scores and the compare views, and writes the same results files.
 *
 *   npm run phoenix:experiment -- --model <id> --dataset public|private --split dev|holdout|all
 *     [--ids <list>] [--repeat n] [--agent real|stub|<module>] [--judges <id,...>] [--dry-run n]
 *     --budget <usd> --name <name>
 *   npm run phoenix:evaluate -- --experiment <id> --evaluators <names> --budget <usd>
 *
 * - Refuses to start unless Phoenix answers on 127.0.0.1:6006 (before any paid call).
 * - The task is runCase inside a `case` span (GUARDRAIL children), concurrency 1. Judges run inside
 *   the task as in run.ts (J0 by default on a real agent; advisory per status.json) and appear as LLM
 *   evaluators without a second call. Each stored run's traceId is its task span's trace id.
 * - --budget: stops before the next example once agent plus judge spend reaches it (later examples are
 *   recorded as errors "stopped for budget"). --budget 0 is allowed only for a stub agent with no
 *   --judges, since the check runs after each paid case.
 * - --ids uploads the selected examples as <dataset>-subset and runs on that. Every run first
 *   uploads its dataset, so Phoenix always holds the cases being run.
 * - --dry-run n: n examples, nothing recorded in the experiment tables and no results files; spans
 *   still go to the project career-agent-evals (a free plumbing check with --agent stub).
 * - Private dataset: Phoenix's logger is quiet (errors as ids only), console lines are ids, pass and spend.
 * - Evaluate: names are "code" (every code family), a code family, "cost_usd", a judge id (J0_rubric)
 *   or a DeepEval score name ("deepeval/faithfulness"). Paid ones share --budget.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "../..");
const DRY_RUN_PROJECT = "career-agent-evals";

export type ExperimentOptions = {
  /** Loaded cases; only those of `dataset` are used. */
  cases: LoadedCase[];
  dataset: "public" | "private";
  split: "dev" | "holdout" | "all";
  ids?: string[];
  repeat: number;
  agent: AgentFn;
  kind: "real" | "stub";
  judges: GateJudge[];
  judgeClient?: JudgeClient;
  model: string;
  career: string;
  budgetUsd: number;
  name: string;
  dryRun?: number;
  status?: EvaluatorStatus;
  holdout: Set<string>;
};
export type ExperimentDeps = {
  phoenixUp: (endpoint: string) => Promise<boolean>;
  createDataset: CreateDataset;
  runExperiment: (p: RunExperimentParams) => Promise<RanExperiment>;
  dirs?: { publicDir: string; privateDir: string };
  print?: (line: string) => void;
};

const noop = () => undefined;
/** Phoenix's logger for private runs: nothing but error lines cut to their quoted ids (task, example, evaluator, run). */
export const quietLogger = (print: (line: string) => void): Logger => ({
  info: noop, warn: noop, log: noop, debug: noop, table: noop,
  error: (m) => print(`error: ${[...m.split(": ")[0].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(" ")}`),
});

function taskOutput(run: CaseRun, c: LoadedCase): TaskOutput {
  const r = run.result;
  const fallback = r.events.find((e) => e.type === "fallback");
  return {
    caseId: r.id,
    rep: r.rep,
    reply: r.reply ?? "",
    question: r.turns?.at(-1)?.question ?? run.question,
    history: run.turnHistories.at(-1) ?? run.history,
    sentences: r.events.flatMap((e) => (e.type === "sentence" ? [{ text: e.text, sources: e.sources }] : [])),
    fallback: fallback ? { reason: fallback.reason, ...(fallback.detail ? { detail: fallback.detail } : {}) } : null,
    checks: r.checks,
    pass: r.pass,
    costUsd: +run.spend.costUsd.toFixed(6),
    judgeCostUsd: +run.spend.judgeCostUsd.toFixed(6),
    isPrivate: c.isPrivate,
  };
}

export async function runPhoenixExperiment(o: ExperimentOptions, deps: ExperimentDeps) {
  if (!(await deps.phoenixUp(PHOENIX_URL))) throw new Error(`Phoenix is not reachable at ${PHOENIX_URL}; start private/phoenix/serve.sh`);
  const print = deps.print ?? ((l: string) => console.log(l));
  const isPrivate = o.dataset === "private";
  const cases = o.cases.filter((c) => c.isPrivate === isPrivate);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const selected = o.ids ? cases.filter((c) => o.ids!.includes(c.id)) : cases;
  const datasetName = o.ids ? `${DATASETS[o.dataset]}-subset` : DATASETS[o.dataset];
  await deps.createDataset({ name: datasetName, description: `career agent ${o.dataset} eval cases`, examples: selected.map((c) => toExample(c, o.holdout)) });

  const startedAt = new Date().toISOString();
  const judges = await judgeHeaders(o.judges);
  const header0 = buildHeader({
    model: o.model, agent: o.kind, startedAt, repeat: o.repeat, only: null, ids: o.ids ?? null, judgeSkipped: false, incomplete: false,
    stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, career: o.career, cases, judges,
  });

  const runs: CaseRun[] = [];
  const reps = new Map<string, number>();
  let spent = 0;
  let stoppedForBudget = false;
  let judgeSkipped = false;
  const task = async (example: Example): Promise<TaskOutput> => {
    const c = byId.get(String(example.id));
    if (!c) throw new Error("example is not a loaded case");
    if (spent > 0 && spent >= o.budgetUsd) {
      stoppedForBudget = true;
      throw new Error("stopped for budget");
    }
    const rep = reps.get(c.id) ?? 0;
    reps.set(c.id, rep + 1);
    // A dry run's task span is never exported, so the case span starts its own trace there.
    const ctx = o.dryRun ? trace.deleteSpan(context.active()) : context.active();
    const run = await context.with(ctx, () =>
      withCaseSpan(
        (r: CaseRun) => caseSpanAttributes(r, c, header0),
        async () => {
          const r = await runCase(c, {
            agent: o.agent, judges: o.judges, rep, model: o.model, career: o.career, status: o.status, judgeClient: o.judgeClient,
          });
          r.result.traceId = activeTraceId();
          recordGuardrails(r.result.checks);
          return r;
        },
        c.followUps?.length ? `${c.id}:${rep}:${startedAt}` : undefined,
      ),
    );
    if (c.judge && !o.judges.length) judgeSkipped = true;
    runs.push(run);
    spent += run.spend.costUsd + run.spend.judgeCostUsd;
    formatRun(run, c.isPrivate).forEach(print);
    return taskOutput(run, c);
  };

  // A dry run records nothing and runExperiment registers no tracer then: send the spans to a project of our own.
  const dryProvider = o.dryRun ? register({ projectName: DRY_RUN_PROJECT, url: PHOENIX_URL, batch: false, global: true }) : undefined;
  let ran: RanExperiment;
  try {
    ran = await deps.runExperiment({
      dataset: { datasetName, ...(o.split === "all" ? {} : { splits: [o.split] }) },
      task,
      evaluators: [...codeEvaluators(), costEvaluator(), ...o.judges.map((j) => judgeEvaluator(j.spec, j.model, { career: o.career }))],
      experimentName: o.name,
      experimentMetadata: {
        model: o.model, agent: o.kind, dataset: o.dataset, split: o.split, ids: o.ids ?? null, budgetUsd: o.budgetUsd,
        promptHash: header0.promptHash, corpusHash: header0.corpusHash, caseSetVersion: header0.caseSetVersion,
        sdkVersions: header0.sdkVersions, judges, gitSha: header0.gitSha,
      },
      concurrency: 1,
      repetitions: o.repeat,
      ...(o.dryRun ? { dryRun: o.dryRun } : {}),
      ...(isPrivate ? { logger: quietLogger(print) } : {}),
    });
  } finally {
    await dryProvider?.shutdown();
  }

  const costUsd = runs.reduce((s, r) => s + r.spend.costUsd, 0);
  const judgeCostUsd = runs.reduce((s, r) => s + r.spend.judgeCostUsd, 0);
  const out = { experimentId: ran.id, runs, stoppedForBudget, costUsd, judgeCostUsd, judgeSkipped };
  if (o.dryRun) return { ...out, paths: null };
  const incomplete = judgeSkipped || !!o.ids || o.split !== "all" || stoppedForBudget;
  const header = {
    ...buildHeader({
      model: o.model, agent: o.kind, startedAt, repeat: o.repeat, only: null, ids: o.ids ?? null, judgeSkipped, incomplete, stoppedForBudget,
      costUsd: +costUsd.toFixed(6), judgeCostUsd: +judgeCostUsd.toFixed(6), career: o.career, cases, judges,
    }),
    experimentId: ran.id,
  };
  const paths = writeResults(startedAt.replace(/[:.]/g, "-"), header, runs, (id) => !!byId.get(id)?.isPrivate, deps.dirs);
  return { ...out, paths, incomplete };
}

/** Evaluators by name for phoenix:evaluate; paid ones share `budget`. */
export function evaluatorsByName(names: string[], o: { career: string; budget: Budget }): Evaluator[] {
  const code = codeEvaluators();
  return names.flatMap((n): Evaluator[] => {
    if (n === "code") return code;
    if (n === "cost_usd") return [costEvaluator()];
    const family = code.find((e) => e.name === n);
    if (family) return [family];
    if (JUDGES[n]) return [judgeEvaluator(JUDGES[n], "claude-sonnet-5-5", o)];
    if (n.startsWith("deepeval/")) return [deepevalEvaluator(n, o)];
    throw new Error(`Unknown evaluator: ${n}`);
  });
}

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function evaluateMain(args: string[]) {
  const { values } = parseArgs({ args, options: { experiment: { type: "string" }, evaluators: { type: "string" }, budget: { type: "string" } } });
  const budgetUsd = Number(values.budget);
  if (!values.experiment || !values.evaluators || values.budget === undefined || !(budgetUsd >= 0))
    fail("Usage: npm run phoenix:evaluate -- --experiment <id> --evaluators <names> --budget <usd>");
  usePhoenixEnv();
  if (!(await phoenixUp(PHOENIX_URL))) fail(`Phoenix is not reachable at ${PHOENIX_URL}; start private/phoenix/serve.sh`);
  const client = createClient({ options: { baseUrl: PHOENIX_URL } });
  const career = readFileSync(join(PUBLIC_ROOT, "corpus/career.md"), "utf8");
  const budget: Budget = { limitUsd: budgetUsd, spentUsd: 0 };
  const evaluators = evaluatorsByName(values.evaluators!.split(",").map((s) => s.trim()).filter(Boolean), { career, budget });
  const experiment = await getExperiment({ client, experimentId: values.experiment! });
  const anyPrivate = Object.values(experiment.runs).some((r) => (r.output as TaskOutput | null)?.isPrivate);
  await evaluateExperiment({ client, experiment, evaluators, concurrency: 1, ...(anyPrivate ? { logger: quietLogger(console.log) } : {}) });
  console.log(`evaluated ${Object.keys(experiment.runs).length} runs; paid evaluator spend $${budget.spentUsd.toFixed(4)} of $${budgetUsd}`);
}

async function experimentMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" }, dataset: { type: "string" }, split: { type: "string" }, ids: { type: "string" }, repeat: { type: "string" },
      agent: { type: "string" }, judges: { type: "string" }, "dry-run": { type: "string" }, budget: { type: "string" }, name: { type: "string" },
    },
  });
  const usage =
    "Usage: npm run phoenix:experiment -- --model <id> --dataset public|private --split dev|holdout|all [--ids <list>] [--repeat n] " +
    "[--agent real|stub|<module>] [--judges <id,...>] [--dry-run n] --budget <usd> --name <name>";
  const repeat = Number(values.repeat ?? 1);
  const dryRun = values["dry-run"] !== undefined ? Number(values["dry-run"]) : undefined;
  const budgetUsd = Number(values.budget);
  const dataset = values.dataset as ExperimentOptions["dataset"];
  const split = values.split as ExperimentOptions["split"];
  if (!values.model || !values.name || values.budget === undefined || !(budgetUsd >= 0) || !["public", "private"].includes(dataset) ||
      !["dev", "holdout", "all"].includes(split) || !Number.isInteger(repeat) || repeat < 1 || (dryRun !== undefined && !(Number.isInteger(dryRun) && dryRun > 0)))
    fail(usage);
  const agentName = values.agent ?? "real";
  if (budgetUsd === 0 && (agentName !== "stub" || values.judges)) fail("--budget 0 is only for --agent stub without --judges.");
  const judgeIds = values.judges?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknownJudge = judgeIds?.find((id) => !JUDGES[id]);
  if (unknownJudge) fail(`Unknown judge: ${unknownJudge}`);

  usePhoenixEnv();
  const model = values.model!;
  const { agent, kind } = await resolveAgent(agentName, model);
  const judges: GateJudge[] = judgeIds ? judgeIds.map((id) => ({ spec: JUDGES[id], model: "claude-sonnet-5-5" })) : judgesFor(kind, false);
  if (dataset === "private" && !existsSync(PRIVATE_CASES)) fail("No private cases.");
  const cases = loadCases([dataset === "private" ? PRIVATE_CASES : PUBLIC_CASES]);
  const ids = values.ids?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids?.filter((id) => !cases.some((c) => c.id === id)) ?? [];
  if (unknown.length) fail(`Unknown case ids: ${unknown.join(", ")}`);

  const client = createClient({ options: { baseUrl: PHOENIX_URL } });
  const out = await runPhoenixExperiment(
    {
      cases, dataset, split, ids, repeat, agent, kind, judges, model, budgetUsd, name: values.name!, dryRun, holdout: loadHoldout(),
      career: readFileSync(join(PUBLIC_ROOT, "corpus/career.md"), "utf8"),
      status: JSON.parse(readFileSync(join(HERE, "../validation/status.json"), "utf8")),
    },
    {
      phoenixUp,
      createDataset: (p) => createDataset({ client, ...p }),
      runExperiment: (p) => runExperiment({ client, ...p }),
    },
  );
  const results = out.runs.map((r) => r.result);
  console.log(
    `\n${results.filter((r) => r.pass).length}/${results.length} passed. cost: agent $${out.costUsd.toFixed(4)} + judge $${out.judgeCostUsd.toFixed(4)}` +
      (out.stoppedForBudget ? ` (stopped at budget $${budgetUsd})` : "") + `\nexperiment: ${out.experimentId}${dryRun ? " (dry run, not recorded)" : ""}`,
  );
  if (!out.paths) return;
  console.log(`results: ${out.paths.publicPath}\n         ${out.paths.privatePath}`);
  const { line, exitCode } = gateSummary(gates(results), !!out.incomplete, out.stoppedForBudget);
  console.log(line);
  process.exitCode = exitCode; // no process.exit: Phoenix's evaluation posts are still in flight
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  await (cmd === "evaluate" ? evaluateMain(rest) : experimentMain(process.argv.slice(2)));
}
