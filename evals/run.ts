import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { makeAgent as makeRealAgent } from "../src/eval-agent";
import type { AgentEvent, CaseResult, CaseSource, CheckResult, EvalCase, Msg, Turn, Usage } from "../src/types";
import { BUDGETS } from "./budgets";
import { defaultJudgeClient, runJudge, type JudgeClient } from "./judge";
import { judgePromptHash } from "./judges/request";
import { J0_RUBRIC } from "./judges/rubric";
import type { JudgeModel, JudgeSpec } from "./judges/spec";
import { makeAgent as makeStubAgent } from "./phoenix/stub-agent";
import { buildHeader, writeResults, type JudgeHeader } from "./results";
import { clopperPearson } from "./stats";
import { applyStatus, casePass, gates, handedOff, mergeTurnSafety, scoreDeterministic, type EvaluatorStatus, type Gates } from "./score";

/*
 * Eval runner.
 *
 *   npm run evals -- --model <id> --cases <dir...> [--repeat n] [--only category] [--ids id,id,...]
 *                    [--agent real|stub|<module>] [--budget <usd>] [--no-judge]
 *
 * The agent is injected: an AgentFn takes a case (question and optional history) and yields the
 * same AgentEvents the production Worker streams; `onText` receives the raw model text (evals only).
 * `--agent real` (default) is src/eval-agent.ts: answer() with a real Anthropic client (the SDK reads
 * ANTHROPIC_API_KEY itself), career.md and ../private/blocklist.json. `--agent stub` is the free
 * evals/phoenix/stub-agent.ts; any other value is a module exporting `makeAgent(model): AgentFn`.
 * A case with `followUps` runs as a conversation: each later question gets the earlier visible
 * replies as history.
 *
 * Running the real agent or the judge calls a paid model. Get Edgar's cost approval first.
 * `--budget` (default BUDGETS.full[model]) stops the run before the next case once agent plus judge
 * spend reaches it; the run is then INCOMPLETE. Use --no-judge to skip rubric cases (judgeSkipped);
 * stub and module agents are never judged, so a stub run with rubric cases is judgeSkipped and INCOMPLETE.
 *
 * Output (both gitignored), see results.ts:
 *  - ../private/evals/results/<timestamp>.json: every run in full, with the raw model text.
 *  - evals/results/<timestamp>.json: public runs without raw text; private runs as id, category, pass.
 *  - The console never shows raw text, and for private cases only ids, pass or fail and spend.
 */

export type AgentFn = (c: EvalCase, o?: { onText?: (delta: string) => void }) => AsyncIterable<AgentEvent>;
/** A judge the run uses on rubric cases: its spec (id = check name = status.json key) and model. */
export type GateJudge = { spec: JudgeSpec; model: JudgeModel };
export type LoadedCase = EvalCase & { isPrivate: boolean };
export type CaseSpend = { usage?: Usage; costUsd: number; judgeCostUsd: number };
export type CaseRun = { result: CaseResult; spend: CaseSpend; rawText: string; question: string; history: Msg[]; turnHistories: Msg[][] };

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..");
const PRIVATE_ROOT = resolve(PUBLIC_ROOT, "../private");
export const CATEGORIES: EvalCase["category"][] = [
  "facts", "conflicts", "fit", "not_in_corpus", "confidential", "attacks", "commitments", "recruiter", "tone", "multiturn",
];
export const J0: GateJudge = { spec: J0_RUBRIC, model: "claude-sonnet-5-5" };
/** Only real runs are judged: a stub or module agent never triggers a paid judge call. */
export const judgesFor = (kind: "real" | "stub", noJudge: boolean): GateJudge[] => (kind === "real" && !noJudge ? [J0] : []);
/** The run header's judges: each GateJudge with its model and prompt hash. */
export const judgeHeaders = (judges: GateJudge[]): Promise<JudgeHeader[]> =>
  Promise.all(judges.map(async (j) => ({ id: j.spec.id, model: j.model, promptHash: await judgePromptHash(j.spec) })));

export function loadCases(dirs: string[]): LoadedCase[] {
  const cases: LoadedCase[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const abs = resolve(dir);
    const isPrivate = abs === PRIVATE_ROOT || abs.startsWith(PRIVATE_ROOT + sep);
    for (const name of readdirSync(abs).filter((f) => f.endsWith(".jsonl")).sort()) {
      readFileSync(join(abs, name), "utf8").split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        const where = `${name}:${i + 1}`; // never includes case text
        let c: EvalCase;
        try {
          c = JSON.parse(line);
        } catch {
          throw new Error(`${where}: invalid JSON`);
        }
        if (typeof c.id !== "string" || typeof c.question !== "string" || !CATEGORIES.includes(c.category))
          throw new Error(`${where}: needs string id, string question and a known category`);
        if (seen.has(c.id)) throw new Error(`${where}: duplicate id`);
        seen.add(c.id);
        cases.push({ ...c, isPrivate });
      });
    }
  }
  return cases;
}

export async function resolveAgent(
  name: "real" | "stub" | string,
  model: string,
  o: { system?: string } = {},
): Promise<{ agent: AgentFn; kind: "real" | "stub" }> {
  if (name === "real") return { agent: makeRealAgent(model, o), kind: "real" };
  if (name === "stub") return { agent: makeStubAgent(model, o), kind: "stub" };
  const mod = await import(pathToFileURL(resolve(name)).href);
  return { agent: mod.makeAgent(model, o), kind: "stub" };
}

const visible = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "sentence" ? [e.text] : [])).join(" ");
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Multi-turn final state: every history sent equals the first one plus the earlier questions and
 * their visible replies (never raw or blocked text), and the case spend equals the sum of turn costs.
 */
export function finalStateChecks(turns: Turn[], historiesSent: Msg[][], turnCosts: number[], spend: CaseSpend): CheckResult[] {
  const historyOk = historiesSent.every((h, i) =>
    sameJson(h, [...historiesSent[0], ...turns.slice(0, i).flatMap((t): Msg[] => [{ role: "user", text: t.question }, { role: "assistant", text: t.reply }])]),
  );
  const sum = turnCosts.reduce((a, b) => a + b, 0);
  const out: CheckResult[] = [
    { name: "final:history-visible-only", pass: historyOk, reason: "a history sent holds text the visitor did not see" },
    { name: "final:spend-sum", pass: Math.abs(spend.costUsd - sum) < 1e-9, reason: "case spend differs from the sum of turn costs" },
  ];
  return out.map((r) => (r.pass ? { name: r.name, pass: true } : r));
}

export async function runCase(
  c: LoadedCase,
  deps: {
    agent: AgentFn; judges: GateJudge[]; rep: number; model: string; career: string; source?: CaseSource; status?: EvaluatorStatus;
    /** Defaults to the real SDK client (paid); tests pass a fake. */
    judgeClient?: JudgeClient;
  },
): Promise<CaseRun> {
  const history = c.history ?? [];
  const questions = [c.question, ...(c.followUps ?? [])];
  const turns: Turn[] = [];
  const turnHistories: Msg[][] = [];
  const turnCosts: number[] = [];
  const spend: CaseSpend = { costUsd: 0, judgeCostUsd: 0 };
  let rawText = "";
  let firstSentence: number | null = null;
  const t0 = performance.now();

  for (const question of questions) {
    const h = [...history, ...turns.flatMap((t): Msg[] => [{ role: "user", text: t.question }, { role: "assistant", text: t.reply }])];
    turnHistories.push(h);
    const events: AgentEvent[] = [];
    if (rawText) rawText += "\n\n";
    try {
      for await (const e of deps.agent({ ...c, history: h, question }, { onText: (d) => (rawText += d) })) {
        if (e.type === "sentence" && firstSentence === null) firstSentence = Math.round(performance.now() - t0);
        events.push(e);
      }
    } catch {
      events.push({ type: "fallback", reason: "api_error" }); // detail omitted: it could echo private text
    }
    let cost = 0;
    for (const e of events)
      if (e.type === "done") {
        cost += e.costUsd;
        const u = (spend.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        u.input += e.usage.input;
        u.output += e.usage.output;
        u.cacheRead += e.usage.cacheRead;
        u.cacheWrite += e.usage.cacheWrite;
      }
    turnCosts.push(cost);
    spend.costUsd += cost;
    turns.push({ question, reply: visible(events), events });
  }
  const latencyMs = { firstSentence, total: Math.round(performance.now() - t0) };

  // Scoring reads the last turn (the only one for a single-turn case); safety checks read every turn.
  const ctx = { career: deps.career, model: deps.model, latencyMs };
  const earlier = turns.slice(0, -1).map((t) => scoreDeterministic({ ...c, question: t.question }, t.reply, t.events, ctx));
  const last = turns.at(-1)!;
  let checks = mergeTurnSafety(scoreDeterministic({ ...c, question: last.question }, last.reply, last.events, ctx), earlier);
  if (c.followUps?.length) checks.push(...finalStateChecks(turns, turnHistories, turnCosts, spend));
  // A judge check is named by its spec id (the status.json family). An error is pass: false with
  // "judge error: <kind>"; like a Fail, applyStatus makes it advisory until the judge is validated.
  // Critiques of private cases stay in the private file; redact() and formatRun keep them out elsewhere.
  if (c.judge)
    for (const j of deps.judges) {
      try {
        const v = await runJudge(j.spec, { reply: last.reply, rubric: c.judge, question: last.question, history: turnHistories.at(-1) }, {
          client: deps.judgeClient ?? defaultJudgeClient(),
          model: j.model,
          corpus: deps.career,
        });
        spend.judgeCostUsd += v.costUsd;
        checks.push(v.error ? { name: j.spec.id, pass: false, reason: `judge error: ${v.error}` } : { name: j.spec.id, pass: v.pass === true, reason: v.critique });
      } catch {
        checks.push({ name: j.spec.id, pass: false, reason: "judge error: api_error" }); // detail omitted: it could echo private text
      }
    }

  if (deps.status) checks = applyStatus(checks, deps.status);

  const result: CaseResult = {
    id: c.id,
    category: c.category,
    pass: casePass(checks),
    checks,
    fellBack: last.events.some((e) => e.type === "fallback"),
    handedOff: handedOff(last.reply, last.events),
    reply: last.reply,
    rep: deps.rep,
    model: deps.model,
    source: deps.source ?? c.source ?? "handwritten",
    slice: c.slice,
    traceId: null,
    events: last.events,
    turns,
    latencyMs,
  };
  return { result, spend, rawText, question: c.question, history, turnHistories };
}

export type RunOptions = {
  agent: AgentFn;
  /** Empty or omitted: rubric cases are skipped and the run is flagged judgeSkipped. */
  judges?: GateJudge[];
  judgeClient?: JudgeClient;
  model: string;
  career: string;
  repeat?: number;
  only?: EvalCase["category"];
  ids?: string[];
  /** Stop before the next case once agent plus judge spend reaches this. */
  budgetUsd?: number;
  /** Overrides every case's source, e.g. "ablation". */
  source?: CaseSource;
  /** validation/status.json: checks whose family is not `code` or `validated` become advisory. */
  status?: EvaluatorStatus;
  onResult?: (run: CaseRun, c: LoadedCase) => void;
};
export type RunOutput = { results: CaseResult[]; costUsd: number; judgeCostUsd: number; judgeSkipped: boolean };

export async function runCases(cases: LoadedCase[], opts: RunOptions): Promise<RunOutput & { runs: CaseRun[]; stoppedForBudget: boolean }> {
  const judges = opts.judges ?? [];
  const runs: CaseRun[] = [];
  let costUsd = 0;
  let judgeCostUsd = 0;
  let judgeSkipped = false;
  let stoppedForBudget = false;
  const selected = cases.filter((c) => (!opts.only || c.category === opts.only) && (!opts.ids || opts.ids.includes(c.id)));
  run: for (let rep = 0; rep < (opts.repeat ?? 1); rep++) {
    for (const c of selected) {
      if (opts.budgetUsd !== undefined && costUsd + judgeCostUsd >= opts.budgetUsd) {
        stoppedForBudget = true;
        break run;
      }
      const r = await runCase(c, {
        agent: opts.agent, judges, rep, model: opts.model, career: opts.career, source: opts.source, status: opts.status, judgeClient: opts.judgeClient,
      });
      if (c.judge && !judges.length) judgeSkipped = true;
      runs.push(r);
      costUsd += r.spend.costUsd;
      judgeCostUsd += r.spend.judgeCostUsd;
      opts.onResult?.(r, c);
    }
  }
  return { results: runs.map((r) => r.result), runs, costUsd, judgeCostUsd, judgeSkipped, stoppedForBudget };
}

/** Console lines for one run: never raw text, and for a private case no check reasons. */
export function formatRun(run: CaseRun, isPrivate: boolean): string[] {
  const { result: r, spend: s } = run;
  const u = s.usage;
  const tokens = u ? `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}` : "no usage";
  const lines = [`${r.pass ? "PASS" : "FAIL"} ${r.id} rep=${r.rep}  ${tokens}  $${s.costUsd.toFixed(5)} judge $${s.judgeCostUsd.toFixed(5)}`];
  // Long judge critiques are cut on the console only; results files keep the full text.
  if (!r.pass && !isPrivate) for (const k of r.checks.filter((k) => !k.pass)) lines.push(`  ${k.name}: ${(k.reason ?? "").slice(0, 300)}`);
  return lines;
}

const f3 = (x: number) => x.toFixed(3);

/**
 * A run that skipped the judge, covered part of the cases (--only, --ids) or stopped for budget
 * checked only part of the gates, so it can never pass: it prints INCOMPLETE and exits 1. Nothing
 * here writes baseline.json; a baseline must be recorded by hand from a complete run.
 * Every gate line prints k/n (distinct cases passing every repeat) and its exact 95% interval.
 */
export function gateSummary(g: Gates, incomplete: boolean, stoppedForBudget = false): { line: string; exitCode: number } {
  const lines = g.lines.map((l) =>
    `  ${l.name} ${l.k}/${l.n} [${f3(l.lo)}, ${f3(l.hi)}] ${l.pass ? "ok" : `fail (${l.failingChecks.join(", ")})`}` +
      (l.upperBound !== undefined ? `; failure rate <= ${f3(l.upperBound)} (95% one-sided), claimable ${l.claimable ? "yes" : "no"}` : ""),
  );
  const cats = Object.entries(g.byCategory).map(([cat, b]) => {
    const ci = clopperPearson(b.passedCases, b.n);
    return `  ${cat}: pass@1 ${b.passedRuns}/${b.runs}, pass^${b.k} ${b.passedCases}/${b.n} [${f3(ci.lo)}, ${f3(ci.hi)}]`;
  });
  const detail = [...lines, `review items: ${g.reviewItems.length ? g.reviewItems.join(", ") : "none"}`, ...cats].join("\n");
  if (stoppedForBudget) return { line: `gates: INCOMPLETE (stopped for budget; not a pass)\n${detail}`, exitCode: 1 };
  if (incomplete) return { line: `gates: INCOMPLETE (judge skipped, --only or --ids set; not a pass)\n${detail}`, exitCode: 1 };
  return { line: `gates: ${g.passed ? "PASS" : "FAIL"}\n${detail}`, exitCode: g.passed ? 0 : 1 };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      cases: { type: "string", multiple: true },
      repeat: { type: "string" },
      only: { type: "string" },
      ids: { type: "string" },
      agent: { type: "string" },
      budget: { type: "string" },
      "no-judge": { type: "boolean" },
    },
  });
  const dirs = [...(values.cases ?? []), ...positionals];
  const only = values.only as EvalCase["category"] | undefined;
  const repeat = Number(values.repeat ?? 1);
  const ids = values.ids?.split(",").map((s) => s.trim()).filter(Boolean);
  const budgetUsd = values.budget !== undefined ? Number(values.budget) : values.model ? BUDGETS.full[values.model] : undefined;
  const usage =
    "Usage: npm run evals -- --model <id> --cases <dir...> [--repeat n] [--only category] [--ids id,id,...] " +
    "[--agent real|stub|<module>] [--budget <usd>] [--no-judge]";
  if (!values.model || !dirs.length || !Number.isInteger(repeat) || repeat < 1 || (only && !CATEGORIES.includes(only)) ||
      (budgetUsd !== undefined && !(budgetUsd >= 0))) {
    console.error(usage);
    process.exit(1);
  }
  const model = values.model;

  const { agent, kind } = await resolveAgent(values.agent ?? "real", model);
  if (kind === "real" && budgetUsd === undefined) {
    console.error(`No standing budget for ${model}: pass --budget <usd>.`);
    process.exit(1);
  }
  const cases = loadCases(dirs);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const unknown = ids?.filter((id) => !byId.has(id)) ?? [];
  if (unknown.length) {
    console.error(`Unknown case ids: ${unknown.join(", ")}`);
    process.exit(1);
  }
  const career = readFileSync(join(PUBLIC_ROOT, "corpus/career.md"), "utf8");
  const judges = judgesFor(kind, !!values["no-judge"]);
  const status: EvaluatorStatus = JSON.parse(readFileSync(join(HERE, "validation/status.json"), "utf8"));
  const startedAt = new Date().toISOString();

  const out = await runCases(cases, {
    agent, judges, model, career, repeat, only, ids, budgetUsd, status,
    onResult: (run, c) => formatRun(run, c.isPrivate).forEach((l) => console.log(l)),
  });
  const { results, costUsd, judgeCostUsd, judgeSkipped, stoppedForBudget } = out;

  const incomplete = judgeSkipped || !!only || !!ids || stoppedForBudget;
  const header = buildHeader({
    model, agent: kind, startedAt, repeat, only: only ?? null, ids: ids ?? null, judgeSkipped, incomplete, stoppedForBudget,
    costUsd: +costUsd.toFixed(6), judgeCostUsd: +judgeCostUsd.toFixed(6), career, cases, judges: await judgeHeaders(judges),
  });
  const stamp = header.startedAt.replace(/[:.]/g, "-");
  const { publicPath, privatePath } = writeResults(stamp, header, out.runs, (id) => !!byId.get(id)?.isPrivate);

  const g = gates(results);
  const n = results.filter((r) => r.pass).length;
  console.log(
    `\n${n}/${results.length} passed. cost: agent $${costUsd.toFixed(4)} + judge $${judgeCostUsd.toFixed(4)} = $${(costUsd + judgeCostUsd).toFixed(4)}` +
      ` (agent $${(costUsd / Math.max(results.length, 1)).toFixed(5)} per case)${judgeSkipped ? " (rubric checks skipped)" : ""}` +
      (stoppedForBudget ? ` (stopped at budget $${budgetUsd})` : ""),
  );
  console.log(`results: ${publicPath}\n         ${privatePath}`);
  const { line, exitCode } = gateSummary(g, incomplete, stoppedForBudget);
  console.log(line);
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
