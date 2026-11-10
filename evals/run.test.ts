import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AgentEvent, EvalCase, Msg } from "../src/types";
import {
  CATEGORIES, finalStateChecks, formatRun, gateSummary, J0, judgeHeaders, judgesFor, loadCases, resolveAgent, runCase, runCases,
  type AgentFn, type GateJudge, type LoadedCase,
} from "./run";
import type { JudgeClient } from "./judge";
import { judgePromptHash } from "./judges/request";
import { J0_RUBRIC } from "./judges/rubric";
import { buildHeader, redact, writeResults } from "./results";
import { gates, scoreDeterministic, type EvaluatorStatus } from "./score";
import type { CaseResult } from "../src/types";

vi.mock("./score", async (orig) => {
  const m = await orig<typeof import("./score")>();
  return { ...m, scoreDeterministic: vi.fn(m.scoreDeterministic) };
});

const say = (text: string): AgentEvent => ({ type: "sentence", text, sources: [] });
const done: AgentEvent = { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, model: "stub" };
const mk = (o: Partial<LoadedCase> & { id: string }): LoadedCase =>
  ({ category: "facts", question: "q", isPrivate: false, ...o });
const stub = (events: AgentEvent[]): AgentFn =>
  async function* () {
    yield* events;
  };
const base = { model: "stub", career: "" };
const result = (o: Partial<CaseResult> & { id: string }): CaseResult => ({
  category: "facts", pass: true, checks: [], fellBack: false, handedOff: false, rep: 0, model: "m", source: "handwritten",
  traceId: null, events: [], latencyMs: { firstSentence: null, total: 0 }, ...o,
});
const j0: GateJudge[] = [{ spec: J0_RUBRIC, model: "claude-sonnet-5-5" }];
/** A fake judge client: answers with this critique and result (and usage), or throws. */
const says = (critique: string, result: string, usage?: { input_tokens: number; output_tokens: number }): JudgeClient => ({
  messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ critique, result }) }], usage }) },
});
const stops = (stop_reason: string): JudgeClient => ({ messages: { create: async () => ({ stop_reason, content: [] }) } });
const throwing: JudgeClient = {
  messages: {
    create: async () => {
      throw new Error("net secretterm");
    },
  },
};

test("runCases joins sentences, scores, sums cost", async () => {
  const { results, costUsd } = await runCases([mk({ id: "a", mustInclude: ["8%"] })], { ...base, agent: stub([say("Grew 8%."), say("Good."), done]) });
  expect(results[0].pass).toBe(true);
  expect(results[0].reply).toBe("Grew 8%. Good.");
  expect(costUsd).toBe(0.5);
});

test("an agent that throws becomes a fallback, not a crash", async () => {
  const { results } = await runCases([mk({ id: "a" })], {
    ...base,
    agent: async function* () {
      throw new Error("boom secretterm");
    },
  });
  expect(results[0].fellBack).toBe(true);
  expect(JSON.stringify(results)).not.toContain("secretterm");
});

test("--only filters and --repeat repeats", async () => {
  const cases = [mk({ id: "a" }), mk({ id: "b", category: "tone" })];
  const { results } = await runCases(cases, { ...base, agent: stub([say("ok")]), only: "tone", repeat: 3 });
  expect(results.map((r) => r.id)).toEqual(["b", "b", "b"]);
});

test("rubric cases use the injected judge, and fail when it fails", async () => {
  const c = mk({ id: "a", judge: "rubric" });
  const pass = await runCases([c], { ...base, agent: stub([say("x")]), judges: j0, judgeClient: says("fine", "Pass") });
  const fail = await runCases([c], { ...base, agent: stub([say("x")]), judges: j0, judgeClient: says("r", "Fail") });
  expect([pass.results[0].pass, fail.results[0].pass]).toEqual([true, false]);
});

test("without a judge, rubric cases are skipped and flagged", async () => {
  const out = await runCases([mk({ id: "a", judge: "rubric" })], { ...base, agent: stub([say("x")]) });
  expect(out.judgeSkipped).toBe(true);
  expect(out.results[0].checks.some((k) => k.name === "J0_rubric")).toBe(false);
});

test("a throwing judge fails the case", async () => {
  const { results } = await runCases([mk({ id: "a", judge: "rubric" })], { ...base, agent: stub([say("x")]), judges: j0, judgeClient: throwing });
  expect(results[0].pass).toBe(false);
  expect(JSON.stringify(results)).not.toContain("secretterm");
});

test("the J0 check is named J0_rubric, also when the judge throws", async () => {
  const c = mk({ id: "a", judge: "rubric" });
  const unjudged = (await runCases([c], { ...base, agent: stub([say("x")]) })).results[0].checks.map((k) => k.name);
  for (const judgeClient of [says("ok", "Pass"), says("no", "Fail"), stops("refusal"), stops("max_tokens"), throwing]) {
    const { results } = await runCases([c], { ...base, agent: stub([say("x")]), judges: j0, judgeClient });
    expect(results[0].checks.map((k) => k.name).filter((n) => !unjudged.includes(n))).toEqual(["J0_rubric"]);
  }
  const status = JSON.parse(readFileSync(resolve(__dirname, "validation/status.json"), "utf8"));
  expect(status).toHaveProperty("J0_rubric");
  expect(J0.spec.id).toBe("J0_rubric");
});

test("judge errors are reported as judge error: <kind>, never a Pass", async () => {
  const c = mk({ id: "a", judge: "rubric" });
  for (const [judgeClient, kind] of [[stops("refusal"), "refusal"], [stops("max_tokens"), "max_tokens"], [says("x", "maybe"), "invalid"], [throwing, "api_error"]] as const) {
    const { results } = await runCases([c], { ...base, agent: stub([say("x")]), judges: j0, judgeClient });
    expect(results[0].checks.find((k) => k.name === "J0_rubric")).toMatchObject({ pass: false, reason: `judge error: ${kind}` });
  }
});

test("once J0_rubric is validated, its failures and errors gate; before that they are advisory", async () => {
  const c = mk({ id: "a", category: "fit", judge: "rubric" });
  for (const judgeClient of [says("no", "Fail"), stops("refusal"), throwing]) {
    const validated = await runCases([c], { ...base, agent: stub([say("x.")]), judges: j0, judgeClient, status: { J0_rubric: { status: "validated" } } });
    expect(validated.results[0].checks.find((k) => k.name === "J0_rubric")?.advisory).toBeUndefined();
    expect(validated.results[0].pass).toBe(false);
    const notYet = await runCases([c], { ...base, agent: stub([say("x.")]), judges: j0, judgeClient, status: { J0_rubric: { status: "not-a-judge" } } });
    expect(notYet.results[0].checks.find((k) => k.name === "J0_rubric")).toMatchObject({ pass: false, advisory: true });
  }
});

test("private judge critiques are redacted", async () => {
  const c = mk({ id: "a", isPrivate: true, judge: "r" });
  const { runs } = await runCases([c], { ...base, agent: stub([say("x")]), judges: j0, judgeClient: says("mentions secretterm", "Fail") });
  const dirs = { publicDir: mkdtempSync(join(tmpdir(), "pub-")), privateDir: mkdtempSync(join(tmpdir(), "priv-")) };
  const header = buildHeader({
    model: "m", agent: "stub", startedAt: "t", repeat: 1, only: null, ids: null, judgeSkipped: false, incomplete: false,
    stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, career: "", cases: [c], judges: [],
  });
  const { publicPath, privatePath } = writeResults("s", header, runs, () => true, dirs);
  expect(readFileSync(publicPath, "utf8")).not.toContain("secretterm");
  expect(formatRun(runs[0], true).join("\n")).not.toContain("secretterm");
  expect(readFileSync(privatePath, "utf8")).toContain("mentions secretterm");
});

test("console critiques are cut to 300 characters; results files keep the full text", async () => {
  const long = "q".repeat(400);
  const { runs } = await runCases([mk({ id: "a", judge: "r" })], { ...base, agent: stub([say("x")]), judges: j0, judgeClient: says(long, "Fail") });
  const line = formatRun(runs[0], false).find((l) => l.includes("J0_rubric"))!;
  expect(line).toContain("q".repeat(300));
  expect(line).not.toContain("q".repeat(301));
  expect(runs[0].result.checks.find((k) => k.name === "J0_rubric")?.reason).toBe(long);
});

test("a stub run never calls the paid judge", () => {
  expect(judgesFor("stub", false)).toEqual([]);
  expect(judgesFor("stub", true)).toEqual([]);
  expect(judgesFor("real", false)).toEqual([J0]);
  expect(judgesFor("real", true)).toEqual([]);
});

test("header judges list each GateJudge with its model and prompt hash", async () => {
  expect(await judgeHeaders(j0)).toEqual([{ id: "J0_rubric", model: "claude-sonnet-5-5", promptHash: await judgePromptHash(J0_RUBRIC) }]);
  expect(await judgeHeaders([])).toEqual([]);
});

test("redact keeps only id, category and pass", () =>
  expect(
    redact({
      id: "a", category: "facts", pass: true, checks: [], fellBack: false, handedOff: false, reply: "secretterm",
      rep: 0, model: "m", source: "handwritten", traceId: null, events: [], latencyMs: { firstSentence: null, total: 0 },
    }),
  ).toEqual({
    id: "a",
    category: "facts",
    pass: true,
  }));

test("incomplete runs never pass the gates", () => {
  const ok = gates([]);
  expect(ok.passed).toBe(true);
  expect(gateSummary(ok, false).exitCode).toBe(0);
  const inc = gateSummary(ok, true);
  expect(inc.exitCode).toBe(1);
  expect(inc.line).toContain("INCOMPLETE");
  expect(inc.line).not.toContain("PASS");
});

test("every gate line prints k/n and an interval", () => {
  const g = gates([
    ...Array.from({ length: 3 }, (_, i) => result({ id: `f${i}`, category: "facts" })),
    result({ id: "a1", category: "attacks", pass: false, checks: [{ name: "mustNotInclude#1", pass: false }] }),
  ]);
  const { line, exitCode } = gateSummary(g, false);
  expect(exitCode).toBe(1);
  expect(line).toContain("gates: FAIL");
  for (const l of g.lines) expect(line).toMatch(new RegExp(`${l.name} ${l.k}/${l.n} \\[\\d\\.\\d{3}, \\d\\.\\d{3}\\]`));
  expect(line).toContain("facts 3/3 [0.292, 1.000]");
  expect(line).toMatch(/attacks 0\/1 .*fail \(mustNotInclude#1\).*claimable no/);
  // per-category rates also print k/n and an interval
  expect(line).toContain("facts: pass@1 3/3, pass^1 3/3 [0.292, 1.000]");
  expect(line).toContain("attacks: pass@1 0/1, pass^1 0/1 [0.000, 0.975]");
});

test("with status applied, a failing judge not marked validated is advisory and the case passes", async () => {
  const status: EvaluatorStatus = { reply: { status: "code" }, J0_rubric: { status: "not-a-judge" } };
  const c = mk({ id: "a", category: "fit", judge: "rubric" });
  const out = await runCases([c], { ...base, agent: stub([say("x.")]), status, judges: j0, judgeClient: says("r", "Fail") });
  expect(out.results[0].checks.find((k) => k.name === "J0_rubric")).toMatchObject({ pass: false, advisory: true });
  expect(out.results[0].pass).toBe(true);
  expect(gates(out.results).reviewItems).toEqual(["a"]);
});

test("stored latency is whole ms and stored costs carry no long digit runs", async () => {
  const pricey: AgentEvent = { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1234567890123, model: "m" };
  const run = await runCase(mk({ id: "a" }), { ...deps(stub([say("x."), pricey])) });
  expect(Number.isInteger(run.result.latencyMs.total)).toBe(true);
  expect(Number.isInteger(run.result.latencyMs.firstSentence!)).toBe(true);
  const dirs = { publicDir: mkdtempSync(join(tmpdir(), "pub-")), privateDir: mkdtempSync(join(tmpdir(), "priv-")) };
  const header = buildHeader({
    model: "m", agent: "stub", startedAt: "t", repeat: 1, only: null, ids: null, judgeSkipped: false, incomplete: false,
    stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, career: "", cases: [mk({ id: "a" })], judges: [],
  });
  const { publicPath, privatePath } = writeResults("s", header, [run], () => false, dirs);
  for (const p of [publicPath, privatePath]) expect(JSON.stringify(JSON.parse(readFileSync(p, "utf8")).runs)).not.toMatch(/\d{10,}/);
});

test("multi-turn: a leak in an earlier turn fails the case", async () => {
  const { agent } = recorder([{ raw: "The secretterm.", shown: ["The secretterm."] }, { raw: "Clean.", shown: ["Clean."] }]);
  const run = await runCase(mk({ id: "a", category: "confidential", followUps: ["q2"], mustNotInclude: ["secretterm"] }), deps(agent));
  expect(run.result.checks.find((k) => k.name === "mustNotInclude#1")?.pass).toBe(false);
  expect(run.result.pass).toBe(false);
  expect(gates([run.result]).passed).toBe(false);
});

// ---- the shipped case files ----
const casesDir = resolve(__dirname, "cases");
const privateDir = resolve(__dirname, "../../private/evals");
const pub = loadCases([casesDir]);
const all = existsSync(privateDir) ? loadCases([casesDir, privateDir]) : pub;
const corpus = readFileSync(resolve(__dirname, "../corpus/career.md"), "utf8");
const headings = new Set([...corpus.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim()));

test("all categories with cases are known, and the nine original ones are covered", () => {
  for (const c of all) expect(CATEGORIES).toContain(c.category);
  const nine = ["facts", "conflicts", "fit", "not_in_corpus", "confidential", "attacks", "commitments", "recruiter", "tone"];
  for (const cat of nine) expect(all.some((c) => c.category === cat), cat).toBe(true);
});
test("case count is at least 60 when the private set is present", () => {
  if (all !== pub) expect(all.length).toBeGreaterThanOrEqual(60);
});
test("every case checks something", () => {
  for (const c of all) expect(!!(c.mustInclude?.length || c.mustNotInclude?.length || c.expectHandoff !== undefined || c.judge), c.id).toBe(true);
});
test("fact cases name sections that exist in career.md", () => {
  const facts = all.filter((c: EvalCase) => c.category === "facts");
  for (const c of facts) {
    expect(c.sections?.length, c.id).toBeGreaterThan(0);
    for (const s of c.sections!) expect(headings.has(s), `${c.id}: ${s}`).toBe(true);
  }
});
test("English, Russian and Armenian questions are present", () => {
  expect(pub.some((c) => /[а-яё]/i.test(c.question))).toBe(true);
  expect(pub.some((c) => /[Ա-֏]/.test(c.question))).toBe(true);
});

test("per-case spend and judge cost are reported, and judge cost stays out of checks", async () => {
  const seen: { costUsd: number; judgeCostUsd: number; usage?: unknown }[] = [];
  const out = await runCases([mk({ id: "a", judge: "r" })], {
    ...base,
    agent: stub([say("x"), done]),
    judges: j0,
    judgeClient: says("ok", "Pass", { input_tokens: 125_000, output_tokens: 0 }),
    onResult: (run) => seen.push(run.spend),
  });
  expect(seen).toEqual([{ usage: done.type === "done" ? done.usage : undefined, costUsd: 0.5, judgeCostUsd: 0.25 }]);
  expect(out.costUsd).toBe(0.5);
  expect(out.judgeCostUsd).toBe(0.25);
  expect(JSON.stringify(out.results[0].checks)).not.toContain("costUsd");
});

// ---- E1: full trace capture and runCase ----

/** A stub that streams `raw` through onText, shows `shown` as sentences, and records the history it got. */
function recorder(turns: { raw: string; shown: string[]; blocked?: boolean; cost?: number }[]) {
  const histories: Msg[][] = [];
  let i = 0;
  const agent: AgentFn = async function* (c, o) {
    histories.push(c.history ?? []);
    const t = turns[Math.min(i++, turns.length - 1)];
    o?.onText?.(t.raw);
    for (const s of t.shown) yield say(s);
    if (t.blocked) yield { type: "fallback", reason: "blocked", detail: "blocklist#1" };
    yield { ...done, costUsd: t.cost ?? 0.5 } as AgentEvent;
  };
  return { agent, histories };
}
const deps = (agent: AgentFn) => ({ agent, judges: [] as GateJudge[], rep: 0, model: "m1", career: "CAREER-TEXT" });

test("runCase records rep, source, events and rawText", async () => {
  const { agent } = recorder([{ raw: "Fine. The secretterm.", shown: ["Fine."], blocked: true }]);
  const run = await runCase(mk({ id: "a", slice: "edge" }), { ...deps(agent), rep: 2 });
  expect(run.result.rep).toBe(2);
  expect(run.result.source).toBe("handwritten");
  expect(run.result.slice).toBe("edge");
  expect(run.result.traceId).toBeNull();
  expect(run.result.events.map((e) => e.type)).toEqual(["sentence", "fallback", "done"]);
  expect(run.rawText).toBe("Fine. The secretterm.");
  expect(run.question).toBe("q");
  expect(run.history).toEqual([]);
});

test("followUps: each later question gets the earlier visible replies as history", async () => {
  const { agent, histories } = recorder([{ raw: "One.", shown: ["One."] }, { raw: "Two.", shown: ["Two."] }, { raw: "Three.", shown: ["Three."] }]);
  const prior: Msg[] = [{ role: "user", text: "h0" }, { role: "assistant", text: "a0" }];
  const run = await runCase(mk({ id: "a", question: "q1", history: prior, followUps: ["q2", "q3"] }), deps(agent));
  expect(histories).toEqual([
    prior,
    [...prior, { role: "user", text: "q1" }, { role: "assistant", text: "One." }],
    [...prior, { role: "user", text: "q1" }, { role: "assistant", text: "One." }, { role: "user", text: "q2" }, { role: "assistant", text: "Two." }],
  ]);
  expect(run.turnHistories).toEqual(histories);
});

test("followUps: result.turns has one Turn per question; reply is the last turn's", async () => {
  const { agent } = recorder([{ raw: "One.", shown: ["One."] }, { raw: "Two.", shown: ["Two."] }]);
  const run = await runCase(mk({ id: "a", question: "q1", followUps: ["q2"] }), deps(agent));
  expect(run.result.turns?.map((t) => [t.question, t.reply])).toEqual([["q1", "One."], ["q2", "Two."]]);
  expect(run.result.reply).toBe("Two.");
});

test("budget stops before the next case and marks the run incomplete", async () => {
  const cases = ["a", "b", "c", "d"].map((id) => mk({ id }));
  const out = await runCases(cases, { ...base, agent: stub([say("x"), done]), budgetUsd: 1 });
  expect(out.results.map((r) => r.id)).toEqual(["a", "b"]);
  expect(out.stoppedForBudget).toBe(true);
  const g = gateSummary(gates([]), false, out.stoppedForBudget);
  expect(g.exitCode).toBe(1);
  expect(g.line).toContain("INCOMPLETE");
});

test("multiturn is a known category", () => {
  expect(CATEGORIES).toContain("multiturn");
  const dir = mkdtempSync(join(tmpdir(), "cases-"));
  writeFileSync(join(dir, "multiturn.jsonl"), JSON.stringify({ id: "m1", category: "multiturn", question: "q", followUps: ["q2"] }) + "\n");
  expect(loadCases([dir]).map((c) => c.id)).toEqual(["m1"]);
});

test("--ids runs exactly the named cases", async () => {
  const cases = ["a", "b", "c"].map((id) => mk({ id }));
  const out = await runCases(cases, { ...base, agent: stub([say("x"), done]), ids: ["c", "a"] });
  expect(out.results.map((r) => r.id).sort()).toEqual(["a", "c"]);
});

test("runCase passes career to scoring and records model and latencyMs", async () => {
  const { agent } = recorder([{ raw: "x.", shown: ["x."] }]);
  const run = await runCase(mk({ id: "a" }), deps(agent));
  expect(vi.mocked(scoreDeterministic)).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "a" }), "x.", expect.any(Array), expect.objectContaining({ career: "CAREER-TEXT", model: "m1" }),
  );
  expect(run.result.model).toBe("m1");
  expect(run.result.latencyMs.total).toBeGreaterThanOrEqual(0);
  expect(typeof run.result.latencyMs.firstSentence).toBe("number");
});

test("source override tags every run of the call", async () => {
  const cases = [mk({ id: "a", source: "tuple" }), mk({ id: "b" })];
  const plain = await runCases(cases, { ...base, agent: stub([say("x"), done]) });
  expect(plain.results.map((r) => r.source)).toEqual(["tuple", "handwritten"]);
  const abl = await runCases(cases, { ...base, agent: stub([say("x"), done]), source: "ablation", repeat: 2 });
  expect(abl.results.map((r) => r.source)).toEqual(["ablation", "ablation", "ablation", "ablation"]);
});

test("resolveAgent maps stub and real, and records kind in the header", async () => {
  expect((await resolveAgent("stub", "m")).kind).toBe("stub");
  expect((await resolveAgent("real", "m")).kind).toBe("real");
  const mod = await resolveAgent("evals/phoenix/stub-agent.ts", "m");
  expect(mod.kind).toBe("stub");
  const events: AgentEvent[] = [];
  for await (const e of (await resolveAgent("stub", "m")).agent(mk({ id: "a", question: "secretterm?" }))) events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "done", costUsd: 0, model: "m" });
  expect(JSON.stringify(events)).not.toContain("secretterm");
});

test("console output never prints rawText", async () => {
  const { agent } = recorder([{ raw: "The secretterm leaked.", shown: [], blocked: true }]);
  const run = await runCase(mk({ id: "a", mustInclude: ["needle"] }), deps(agent));
  expect(run.rawText).toContain("secretterm");
  for (const isPrivate of [false, true]) expect(formatRun(run, isPrivate).join("\n")).not.toContain("secretterm");
});

test("final state: a blocked turn's raw text never enters the next turn's history", async () => {
  const { agent, histories } = recorder([{ raw: "Fine. The secretterm.", shown: ["Fine."], blocked: true }, { raw: "Two.", shown: ["Two."] }]);
  const run = await runCase(mk({ id: "a", followUps: ["q2"] }), deps(agent));
  expect(JSON.stringify(histories)).not.toContain("secretterm");
  expect(histories[1].at(-1)).toEqual({ role: "assistant", text: "Fine." });
  expect(run.result.checks.find((k) => k.name === "final:history-visible-only")?.pass).toBe(true);
  // A history that carried the raw text fails the check.
  const turns = run.result.turns!;
  const bad = [histories[0], [{ role: "user", text: "q" }, { role: "assistant", text: "Fine. The secretterm." }] as Msg[]];
  const k = finalStateChecks(turns, bad, [0.5, 0.5], { costUsd: 1, judgeCostUsd: 0 });
  expect(k.find((x) => x.name === "final:history-visible-only")?.pass).toBe(false);
});

test("final state: case spend equals the sum of turn costs", async () => {
  const { agent } = recorder([{ raw: "One.", shown: ["One."], cost: 0.25 }, { raw: "Two.", shown: ["Two."], cost: 0.5 }]);
  const run = await runCase(mk({ id: "a", followUps: ["q2"] }), deps(agent));
  expect(run.spend.costUsd).toBe(0.75);
  expect(run.result.checks.find((k) => k.name === "final:spend-sum")?.pass).toBe(true);
  const k = finalStateChecks(run.result.turns!, run.turnHistories, [0.25, 0.5], { costUsd: 0.5, judgeCostUsd: 0 });
  expect(k.find((x) => x.name === "final:spend-sum")?.pass).toBe(false);
});
