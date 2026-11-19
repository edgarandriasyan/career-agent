import { expect, test } from "vitest";
import type { ClaudeRequest, JudgeResponse } from "./judges/request";
import { agentRecords, buildCosts, capFor, costsMarkdown, meteredClient, newMeter, price, summarize, type BudgetInput, type CallRecord, type Component } from "./pilot";
import type { StoredRun } from "./results";

const req = (model: ClaudeRequest["model"]): ClaudeRequest => ({ model, max_tokens: 8192, output_config: { effort: "low" }, messages: [{ role: "user", content: "q" }] });
const res = (r: Partial<JudgeResponse> = {}): JudgeResponse => ({
  stop_reason: "end_turn",
  content: [],
  usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...r,
});
const rec = (r: Partial<CallRecord>): CallRecord => ({ component: "c", model: "claude-haiku-5-5", caseId: "a", usage: null, costUsd: 0, stopReason: "end_turn", ...r });

test("meteredClient records usage, cost, case and stop reason per call", async () => {
  const meter = newMeter(1);
  meter.component = "J0 judge";
  meter.caseId = "facts-01";
  const client = meteredClient({ messages: { create: async () => res({ stop_reason: "refusal" }) } }, meter);
  await client.messages.create(req("claude-sonnet-5-5"));
  expect(meter.records).toEqual([
    { component: "J0 judge", model: "claude-sonnet-5-5", caseId: "facts-01", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 2, stopReason: "refusal" },
  ]);
  expect(meter.spentUsd).toBe(2);
});

test("meteredClient refuses the next call once the budget is spent, and records thrown errors without usage", async () => {
  const meter = newMeter(0.1);
  const ok = meteredClient({ messages: { create: async () => res() } }, meter);
  await ok.messages.create(req("claude-haiku-5-5")); // $0.10
  await expect(ok.messages.create(req("claude-haiku-5-5"))).rejects.toThrow("stopped for budget");
  expect(meter.records).toHaveLength(1);

  const m2 = newMeter(1);
  const bad = meteredClient({ messages: { create: async () => { throw Object.assign(new Error("boom"), { status: 400 }); } } }, m2);
  await expect(bad.messages.create(req("claude-haiku-5-5"))).rejects.toThrow("boom");
  expect(m2.records[0]).toMatchObject({ usage: null, costUsd: 0, stopReason: null, error: "Error 400" });
});

test("summarize gives cost per call and per case, cache read share and error counts", () => {
  const u = (input: number, cacheRead: number, cacheWrite: number) => ({ input, output: 10, cacheRead, cacheWrite });
  const records = [
    rec({ caseId: "a", usage: u(100, 0, 900), costUsd: 0.3 }),
    rec({ caseId: "a", usage: u(100, 900, 0), costUsd: 0.1 }),
    rec({ caseId: "b", usage: u(100, 900, 0), costUsd: 0.1, stopReason: "refusal" }),
    rec({ caseId: "b", usage: null, costUsd: 0, stopReason: null, error: "Error 500" }),
    rec({ caseId: "b", usage: u(100, 0, 0), costUsd: 0.1, stopReason: "max_tokens" }),
  ];
  const c = summarize("J0 judge", "claude-sonnet-5-5", records, { schemaRetries: 1, extraErrors: 2 });
  expect(c).toEqual({
    name: "J0 judge", model: "claude-sonnet-5-5", calls: 5, costPerCall: 0.12, costPerCase: 0.3,
    cacheReadShare: 0.581, errors: 4, refusals: 1, schemaRetries: 1,
  });
  expect(summarize("x", "claude-haiku-5-5", []).calls).toBe(0);
});

test("agentRecords makes one record per bot call, across every turn", () => {
  const done = (cost: number) => ({ type: "done" as const, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, costUsd: cost, model: "claude-haiku-5-5" });
  const run = {
    id: "mt-01", model: "claude-haiku-5-5",
    turns: [{ question: "q1", reply: "r", events: [done(0.1)] }, { question: "q2", reply: "r", events: [{ type: "fallback", reason: "api_error" }, done(0.2)] }],
  } as unknown as StoredRun;
  const out = agentRecords([run], "bot");
  expect(out.map((r) => [r.caseId, r.costUsd, r.stopReason])).toEqual([["mt-01", 0.1, null], ["mt-01", 0.2, null]]);
  expect(out[0]).toMatchObject({ component: "bot", model: "claude-haiku-5-5", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } });
});

const comp = (name: string, model: string, costPerCall: number, costPerCase = costPerCall): Component => ({
  name, model, calls: 1, costPerCall, costPerCase, cacheReadShare: 0.995, errors: 0, refusals: 0, schemaRetries: 0,
});
const H = "claude-haiku-5-5";
const S = "claude-sonnet-5-5";
const input: BudgetInput = {
  date: "2026-11-19",
  phases: [
    { phase: "C", item: "Run A", lean: [{ n: 100, component: "bot", model: H }], recommended: [{ n: 100, component: "bot", model: H }], ceiling: [{ n: 100, component: "bot", model: S }] },
    {
      phase: "E", item: "Synth", lean: [{ n: 10, component: "synth", model: H, per: "case", factor: 0.5 }],
      recommended: [{ n: 10, component: "synth", model: S, per: "case", factor: 0.5 }], ceiling: [{ n: 10, component: "synth", model: S, per: "case", factor: 0.5 }],
    },
  ],
  recurring: { pr: { [H]: [{ n: 100, component: "bot", model: H }, { n: 10, component: "judge", model: S }] }, full: { [H]: [{ n: 1000, component: "bot", model: H }] } },
  notes: ["A note."],
};
const parts = [
  { components: [comp("bot", H, 0.001), comp("bot", S, 0.01)] },
  { components: [comp("judge", S, 0.005), comp("synth", H, 0.001, 0.008), comp("synth", S, 0.01, 0.08)] },
];
const CURRENT = { pr: { [H]: 0.5 }, full: { [H]: 3 } };

test("capFor is the estimate x 1.5 rounded up to a quarter-dollar", () => {
  expect(capFor(0.15)).toBe(0.25);
  expect(capFor(0.5)).toBe(0.75);
  expect(capFor(2.7)).toBe(4.25);
  expect(capFor(1)).toBe(1.5);
});

test("price multiplies volume by the measured per-call or per-case cost and spells out the arithmetic", () => {
  const { point, basis } = price([{ n: 10, component: "synth", model: S, per: "case", factor: 0.5 }, { n: 100, component: "bot", model: H }], parts.flatMap((p) => p.components));
  expect(point).toBeCloseTo(0.5);
  expect(basis).toBe("10 x synth sonnet per case x 0.5 ($0.04000) + 100 x bot haiku per call ($0.00100) = $0.50");
  expect(() => price([{ n: 1, component: "nope", model: H }], [])).toThrow("no measured component nope");
});

test("buildCosts merges the parts in order, computes each range and sums the totals from the rows", () => {
  const c = buildCosts(parts, input, CURRENT);
  expect(c.components.map((k) => `${k.name}/${k.model}`)).toEqual(["bot/" + H, "bot/" + S, "judge/" + S, "synth/" + H, "synth/" + S]);
  const b = c.budgets;
  expect(b.status).toBe("Proposed, awaiting Edgar's approval");
  expect(b.phases.map((p) => p.lean.range)).toEqual([[0.1, 0.15], [0.04, 0.06]]);
  expect(b.phases.map((p) => p.ceiling.range)).toEqual([[1, 1.5], [0.4, 0.6]]);
  for (const k of ["lean", "recommended", "ceiling"] as const)
    for (const i of [0, 1]) expect(b.totals[k][i]).toBeCloseTo(b.phases.reduce((s, p) => s + p[k].range[i], 0), 9);
  expect(b.proposedCaps.pr[H]).toMatchObject({ estimate: 0.15, cap: 0.25 });
  expect(b.proposedCaps.full[H]).toMatchObject({ estimate: 1, cap: 1.5 });
  expect(b.current).toBe(CURRENT);
  expect(c.notes).toEqual(["A note."]);
});

test("costsMarkdown renders components, proposed caps, the phase table and the per-row arithmetic", () => {
  const md = costsMarkdown(buildCosts(parts, input, CURRENT));
  expect(md).toContain("| bot | claude-haiku-5-5 | 1 | $0.00100 | $0.00100 | 99.5% | 0 | 0 | 0 |");
  expect(md).toContain("## Phase budgets from E11 on (Proposed, awaiting Edgar's approval)");
  expect(md).toContain("| C | Run A | $0.10 to 0.15 | $0.10 to 0.15 | $1.00 to 1.50 |");
  expect(md).toContain("| Total | | $0.14 to 0.21 | $0.50 to 0.75 | $1.40 to 2.10 |");
  expect(md).toContain("  - ceiling: 100 x bot sonnet per call ($0.01000) = $1.00");
  expect(md).toContain("| `claude-haiku-5-5` | $0.50 | $0.25 ($0.15) | $3.00 | $1.50 ($1.00) |");
  expect(md).toContain("- A note.");
});
