import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { costUsd } from "../src/spend";
import { BUDGETS } from "./budgets";
import type { Usage } from "../src/types";
import type { JudgeClient } from "./judge";
import type { ClaudeRequest } from "./judges/request";
import { lastTurnView, type ResultsFile, type StoredRun } from "./results";
import type { CaseRun } from "./run";

/*
 * E10 pilot: measured cost per component, and costs.json / costs.md built from them.
 *
 *   ../private/evals/with-key.sh npx tsx evals/pilot.ts run --results <private results file> --budget <usd>
 *     Paid (Edgar's approval first). On every run in the file: J0 on Sonnet and Opus (runJudge), then
 *     DeepEval TS (scoreDeepEval with a ClaudeJudge) on Haiku and Sonnet. Every call goes through one
 *     metered client that refuses the next call once --budget is spent. Writes the call records and
 *     component summaries to ../private/evals/results/pilot/ts-<stamp>.json (no case text).
 *   npx tsx evals/pilot.ts costs --parts <file...> --budgets <file>
 *     Free. Merges the `components` of each part (TS, Python, bot runs) and prices the budgets file's
 *     per-row terms (volume x a measured component's cost) into phase ranges, totals and proposed caps;
 *     writes evals/costs.json and evals/costs.md: aggregates only, never case text.
 *   npx tsx evals/pilot.ts agent --results <file...>
 *     Free. Bot cost per call from stored runs, written next to the TS part.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..");
const PILOT_DIR = resolve(PUBLIC_ROOT, "../private/evals/results/pilot");

export type CallRecord = {
  component: string;
  model: string;
  caseId: string;
  usage: Usage | null;
  costUsd: number;
  stopReason: string | null;
  error?: string;
};
export type Component = {
  name: string;
  model: string;
  calls: number;
  costPerCall: number;
  costPerCase: number;
  /** Cache-read tokens over all input tokens (uncached + cache read + cache write). */
  cacheReadShare: number;
  errors: number;
  refusals: number;
  schemaRetries: number;
};
type Range = [number, number];
type Paths<T> = { lean: T; recommended: T; ceiling: T };
type Kind = "pr" | "full";
/** n units of a measured component's cost per call (default) or per case, times factor (default 1). */
export type Term = { n: number; component: string; model: string; per?: "call" | "case"; factor?: number };
/** The private input `costs` reads: per-row terms only; every price, range, total and cap is computed. */
export type BudgetInput = {
  date: string;
  phases: ({ phase: string; item: string } & Paths<Term[]>)[];
  recurring: Record<Kind, Record<string, Term[]>>;
  notes: string[];
};
export type Priced = { range: Range; basis: string };
export type Budgets = {
  status: string;
  phases: ({ phase: string; item: string } & Paths<Priced>)[];
  totals: Paths<Range>;
  /** The caps in budgets.ts today. */
  current: Record<Kind, Record<string, number>>;
  /** cap = estimate x 1.5, rounded up to a quarter-dollar. */
  proposedCaps: Record<Kind, Record<string, { estimate: number; cap: number; basis: string }>>;
};
export type Costs = { date: string; components: Component[]; budgets: Budgets; notes: string[] };
export type Meter = { limitUsd: number; spentUsd: number; records: CallRecord[]; component: string; caseId: string };

export const newMeter = (limitUsd: number): Meter => ({ limitUsd, spentUsd: 0, records: [], component: "", caseId: "" });

/** Wraps a client so every call is recorded under meter.component and meter.caseId; refuses a call once the budget is spent. */
export function meteredClient(inner: JudgeClient<ClaudeRequest>, meter: Meter): JudgeClient<ClaudeRequest> {
  return {
    messages: {
      create: async (p) => {
        if (meter.spentUsd >= meter.limitUsd) throw new Error("stopped for budget");
        const base = { component: meter.component, model: p.model, caseId: meter.caseId };
        try {
          const res = await inner.messages.create(p);
          const u = res.usage;
          const usage = u
            ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
            : null;
          const cost = usage ? costUsd(p.model, usage) : 0;
          meter.spentUsd += cost;
          meter.records.push({ ...base, usage, costUsd: cost, stopReason: res.stop_reason });
          return res;
        } catch (e) {
          // The error kind and status only: a message could echo the prompt.
          const status = (e as { status?: number })?.status;
          meter.records.push({ ...base, usage: null, costUsd: 0, stopReason: null, error: `${(e as Error)?.name ?? "Error"}${status ? ` ${status}` : ""}` });
          throw e;
        }
      },
    },
  };
}

const round = (x: number, d: number) => +x.toFixed(d);

export function summarize(name: string, model: string, records: CallRecord[], o: { schemaRetries?: number; extraErrors?: number } = {}): Component {
  const total = records.reduce((s, r) => s + r.costUsd, 0);
  const cases = new Set(records.map((r) => r.caseId)).size;
  let read = 0;
  let all = 0;
  for (const r of records)
    if (r.usage) {
      read += r.usage.cacheRead;
      all += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
    }
  return {
    name,
    model,
    calls: records.length,
    costPerCall: records.length ? round(total / records.length, 6) : 0,
    costPerCase: cases ? round(total / cases, 6) : 0,
    cacheReadShare: all ? round(read / all, 3) : 0,
    errors: records.filter((r) => r.error || r.stopReason === "max_tokens" || r.stopReason === "model_context_window_exceeded").length + (o.extraErrors ?? 0),
    refusals: records.filter((r) => r.stopReason === "refusal").length,
    schemaRetries: o.schemaRetries ?? 0,
  };
}

/** One record per bot call (each turn's `done` event) in stored runs. */
export function agentRecords(runs: StoredRun[], component: string): CallRecord[] {
  return runs.flatMap((r) =>
    r.turns.flatMap((t) =>
      t.events.flatMap((e): CallRecord[] =>
        e.type === "done" ? [{ component, model: e.model, caseId: r.id, usage: e.usage, costUsd: e.costUsd, stopReason: null }] : [],
      ),
    ),
  );
}

const usd = (x: number, d = 5) => `$${x.toFixed(d)}`;
const range = ([lo, hi]: Range) => `$${lo.toFixed(2)} to ${hi.toFixed(2)}`;
const short = (model: string) => model.replace(/^claude-|-5-5$/g, "");
const r2 = (x: number) => round(x, 2);
const PATHS = ["lean", "recommended", "ceiling"] as const;

/** Prices terms against the measured components; the basis spells out the arithmetic. */
export function price(terms: Term[], components: Component[]): { point: number; basis: string } {
  const parts = terms.map((t) => {
    const k = components.find((c) => c.name === t.component && c.model === t.model);
    if (!k) throw new Error(`no measured component ${t.component} on ${t.model}`);
    const unit = (t.per === "case" ? k.costPerCase : k.costPerCall) * (t.factor ?? 1);
    return { cost: t.n * unit, text: `${t.n} x ${t.component} ${short(t.model)} per ${t.per ?? "call"}${t.factor ? ` x ${t.factor}` : ""} (${usd(unit)})` };
  });
  const point = parts.reduce((s, p) => s + p.cost, 0);
  return { point, basis: `${parts.map((p) => p.text).join(" + ")} = ${usd(point, 2)}` };
}

export const capFor = (estimate: number) => Math.ceil(round(estimate * 1.5 * 4, 9)) / 4;

/** Phase ranges ([point, 1.5 x point]), totals summed from the rows, and proposed caps from the recurring terms. */
export function buildBudgets(input: BudgetInput, components: Component[], current: Budgets["current"]): Budgets {
  const phases = input.phases.map((p) => {
    const priced = (terms: Term[]): Priced => {
      const { point, basis } = price(terms, components);
      return { range: [r2(point), r2(point * 1.5)], basis };
    };
    return { phase: p.phase, item: p.item, lean: priced(p.lean), recommended: priced(p.recommended), ceiling: priced(p.ceiling) };
  });
  const total = (k: (typeof PATHS)[number]): Range => [r2(phases.reduce((s, p) => s + p[k].range[0], 0)), r2(phases.reduce((s, p) => s + p[k].range[1], 0))];
  const caps = (byModel: Record<string, Term[]>) =>
    Object.fromEntries(Object.entries(byModel).map(([m, terms]) => {
      const { point, basis } = price(terms, components);
      return [m, { estimate: r2(point), cap: capFor(point), basis }];
    }));
  return {
    status: "Proposed, awaiting Edgar's approval",
    phases,
    totals: { lean: total("lean"), recommended: total("recommended"), ceiling: total("ceiling") },
    current,
    proposedCaps: { pr: caps(input.recurring.pr), full: caps(input.recurring.full) },
  };
}

/** Merges the parts' components and prices the budget input. */
export function buildCosts(parts: { components: Component[] }[], input: BudgetInput, current: Budgets["current"]): Costs {
  const components = parts.flatMap((p) => p.components);
  return { date: input.date, components, budgets: buildBudgets(input, components, current), notes: input.notes };
}

export function costsMarkdown(c: Costs): string {
  const b = c.budgets;
  const models = [...new Set(Object.values(b.proposedCaps).flatMap((m) => Object.keys(m)))];
  return [
    "# Measured eval costs",
    "",
    `Pilot of ${c.date} (E10): 5 public dev cases, every component on the models below. Generated from \`costs.json\` by \`evals/pilot.ts costs\`; do not edit by hand. Costs in USD from \`src/spend.ts\` rates.`,
    "",
    "## Per component",
    "",
    "| Component | Model | Calls | Per call | Per case | Cache read share | Errors | Refusals | Schema retries |",
    "|---|---|---|---|---|---|---|---|---|",
    ...c.components.map((k) =>
      `| ${k.name} | ${k.model} | ${k.calls} | ${usd(k.costPerCall)} | ${usd(k.costPerCase)} | ${(k.cacheReadShare * 100).toFixed(1)}% | ${k.errors} | ${k.refusals} | ${k.schemaRetries} |`,
    ),
    "",
    `## Standing caps (${b.status})`,
    "",
    "`BUDGETS` in `budgets.ts` keeps the current caps until Edgar approves. Proposed cap = estimate x 1.5, rounded up to a quarter-dollar; caps cover the bot and its judges.",
    "",
    "| Model | PR subset: current | PR subset: proposed (estimate) | Full run, 3 repeats: current | Full run: proposed (estimate) |",
    "|---|---|---|---|---|",
    ...models.map((m) => {
      const pr = b.proposedCaps.pr[m];
      const full = b.proposedCaps.full[m];
      return `| \`${m}\` | ${usd(b.current.pr[m] ?? 0, 2)} | ${usd(pr.cap, 2)} (${usd(pr.estimate, 2)}) | ${usd(b.current.full[m] ?? 0, 2)} | ${usd(full.cap, 2)} (${usd(full.estimate, 2)}) |`;
    }),
    "",
    ...(["pr", "full"] as const).flatMap((k) => models.map((m) => `- ${k === "pr" ? "PR subset" : "Full run"}, ${short(m)} bot: ${b.proposedCaps[k][m].basis}`)),
    "",
    `## Phase budgets from E11 on (${b.status})`,
    "",
    "Lean: Haiku wherever validated, Sonnet judge development. Recommended: Opus judge development, Sonnet baselines and Synthesizer, Haiku elsewhere. Ceiling: Sonnet everywhere and Opus judge development. Each range is [estimate, estimate x 1.5]; the totals are the sums of the rows. For the Synthesizer and simulator components, \"per case\" is per run (2 goldens, 1 conversation).",
    "",
    "| Phase | Item | Lean | Recommended | All-Sonnet ceiling |",
    "|---|---|---|---|---|",
    ...b.phases.map((p) => `| ${p.phase} | ${p.item} | ${range(p.lean.range)} | ${range(p.recommended.range)} | ${range(p.ceiling.range)} |`),
    `| Total | | ${range(b.totals.lean)} | ${range(b.totals.recommended)} | ${range(b.totals.ceiling)} |`,
    "",
    "### Per-row arithmetic (estimate)",
    "",
    ...b.phases.flatMap((p) => [
      `- ${p.phase}, ${p.item}:`,
      ...PATHS.map((k) => `  - ${k}: ${p[k].basis}`),
    ]),
    "",
    "## Notes",
    "",
    ...c.notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
}

/** A stored run as the CaseRun slice that runJudge inputs and toTestCase read. */
const toCaseRun = (r: StoredRun): CaseRun =>
  ({ result: { id: r.id, reply: r.reply, rep: r.rep, traceId: r.traceId, events: r.events, turns: r.turns }, question: r.question, rawText: r.rawText ?? "", history: r.history }) as unknown as CaseRun;

async function runMain(args: string[]) {
  const { values } = parseArgs({ args, options: { results: { type: "string" }, budget: { type: "string" } } });
  const budgetUsd = Number(values.budget);
  if (!values.results || !(budgetUsd > 0)) throw new Error("Usage: pilot.ts run --results <private results file> --budget <usd>");
  const [{ defaultJudgeClient, runJudge }, { J0_RUBRIC }, { loadCases }, { PUBLIC_CASES }, { ClaudeJudge }, { scoreDeepEval }] = await Promise.all([
    import("./judge"), import("./judges/rubric"), import("./run"), import("./phoenix/datasets"), import("./deepeval/claude-judge"), import("./deepeval/suites"),
  ]);
  const file: ResultsFile = JSON.parse(readFileSync(values.results, "utf8"));
  const byId = new Map(loadCases([PUBLIC_CASES]).map((c) => [c.id, c]));
  const runs = file.runs.filter((r) => !r.isPrivate && byId.has(r.id)); // public cases only
  const career = readFileSync(join(PUBLIC_ROOT, "corpus/career.md"), "utf8");
  const meter = newMeter(budgetUsd);
  const client = meteredClient(defaultJudgeClient(), meter);
  const components: Component[] = [];

  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"] as const) {
    meter.component = "J0 judge";
    let invalid = 0;
    for (const r of runs) {
      const c = byId.get(r.id)!;
      if (!c.judge) continue;
      meter.caseId = r.id;
      const { question, history } = lastTurnView(r);
      try {
        const v = await runJudge(J0_RUBRIC, { reply: r.reply, rubric: c.judge, question, history }, { client, model, corpus: career });
        if (v.error === "invalid") invalid++;
        console.log(`J0 ${model} ${r.id}: ${v.pass === null ? `error ${v.error}` : v.pass ? "pass" : "fail"} $${v.costUsd.toFixed(5)}`);
      } catch (e) {
        console.log(`J0 ${model} ${r.id}: ${(e as Error).message === "stopped for budget" ? "stopped for budget" : "error"}`);
      }
    }
    components.push(summarize("J0 judge", model, meter.records.filter((x) => x.component === "J0 judge" && x.model === model), { extraErrors: invalid }));
  }

  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"] as const) {
    const name = "DeepEval TS (scoreDeepEval)";
    meter.component = name;
    const judge = new ClaudeJudge({ model, client });
    const scores = [];
    for (const r of runs) {
      meter.caseId = r.id;
      scores.push(...(await scoreDeepEval([{ run: toCaseRun(r), c: byId.get(r.id)! }], { judge, career, budgetUsd: Infinity })));
    }
    for (const s of scores) console.log(`${s.metric} ${model} ${s.caseId}: ${s.error ? `error ${s.error.split(":")[0]}` : `${s.pass} ${s.score}`} $${s.costUsd.toFixed(5)}`);
    const nonApi = scores.filter((s) => s.error && s.error !== "refusal" && s.error !== "max_tokens").length; // bad JSON, missing input
    const thrown = meter.records.filter((x) => x.component === name && x.model === model && x.error).length;
    components.push(summarize(name, model, meter.records.filter((x) => x.component === name && x.model === model), {
      schemaRetries: judge.schemaRetries, extraErrors: Math.max(0, nonApi - thrown),
    }));
  }

  const out = join(PILOT_DIR, `ts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(PILOT_DIR, { recursive: true });
  writeFileSync(out, JSON.stringify({ spentUsd: meter.spentUsd, components, records: meter.records }, null, 2));
  for (const k of components) console.log(JSON.stringify(k));
  console.log(`spent $${meter.spentUsd.toFixed(5)} of $${budgetUsd}\nwrote ${out}`);
}

function agentMain(args: string[]) {
  const { values } = parseArgs({ args, options: { results: { type: "string", multiple: true } } });
  if (!values.results?.length) throw new Error("Usage: pilot.ts agent --results <file...>");
  const components = values.results.map((f) => {
    const file: ResultsFile = JSON.parse(readFileSync(f, "utf8"));
    const records = agentRecords(file.runs, "bot (answer)");
    const apiErrors = file.runs.flatMap((r) => r.turns.flatMap((t) => t.events)).filter((e) => e.type === "fallback" && e.reason === "api_error").length;
    return summarize("bot (answer)", file.header.model, records, { extraErrors: apiErrors });
  });
  const out = join(PILOT_DIR, "agent.json");
  mkdirSync(PILOT_DIR, { recursive: true });
  writeFileSync(out, JSON.stringify({ components }, null, 2));
  for (const k of components) console.log(JSON.stringify(k));
  console.log(`wrote ${out}`);
}

function costsMain(args: string[]) {
  const { values } = parseArgs({ args, options: { parts: { type: "string", multiple: true }, budgets: { type: "string" } } });
  if (!values.parts?.length || !values.budgets) throw new Error("Usage: pilot.ts costs --parts <file...> --budgets <file>");
  const parts = values.parts.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const costs = buildCosts(parts, JSON.parse(readFileSync(values.budgets, "utf8")), BUDGETS);
  writeFileSync(join(HERE, "costs.json"), JSON.stringify(costs, null, 2) + "\n");
  writeFileSync(join(HERE, "costs.md"), costsMarkdown(costs));
  console.log("wrote evals/costs.json and evals/costs.md");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "run") await runMain(rest);
  else if (cmd === "agent") agentMain(rest);
  else if (cmd === "costs") costsMain(rest);
  else {
    console.error("Usage: pilot.ts run|agent|costs ...");
    process.exit(1);
  }
}
