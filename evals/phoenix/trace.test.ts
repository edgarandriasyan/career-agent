import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { register } from "@arizeai/phoenix-otel";
import { afterAll, expect, test } from "vitest";
import type { AgentEvent } from "../../src/types";
import type { RunHeader } from "../results";
import type { CaseRun, LoadedCase } from "../run";
import { caseLanguage, caseSpanAttributes, recordGuardrails, withCaseSpan } from "./trace";

const exporter = new InMemorySpanExporter();
const provider = register({ projectName: "test", spanProcessors: [new SimpleSpanProcessor(exporter)], global: true });
afterAll(() => provider.shutdown());

const header: RunHeader = {
  model: "stub", agent: "stub", startedAt: "2026-11-10T00:00:00.000Z", repeat: 1, only: null, ids: null, subset: "all",
  judgeSkipped: false, incomplete: false, stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, promptHash: "p123", corpusHash: "c123",
  caseSetVersion: "v123", sdkVersions: { anthropic: "1", deepeval: null, phoenixClient: null, phoenixOtel: null, node: "v1" },
  judges: [{ id: "J0_rubric", model: "claude-sonnet-5-5", promptHash: "j123" }], gitSha: "abc",
};
const c: LoadedCase = { id: "fit-01", category: "fit", question: "Is he a fit?", isPrivate: false, source: "tuple", tuple: "t1" };
const events: AgentEvent[] = [
  { type: "sentence", text: "He led a team.", sources: ["Moonfare"] },
  { type: "fallback", reason: "blocked", detail: "blocklist term #3" },
  { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, model: "stub" },
];
const run: CaseRun = {
  result: {
    id: "fit-01", category: "fit", pass: false, checks: [], fellBack: true, handedOff: true, reply: "He led a team.", rep: 2, model: "stub",
    source: "tuple", traceId: null, events, latencyMs: { firstSentence: 1, total: 2 },
  },
  spend: { costUsd: 0.25, judgeCostUsd: 0 },
  rawText: "He led a team. RAWBLOCKEDSENTENCE",
  question: "Is he a fit?",
  history: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
  turnHistories: [],
};

test("case span attributes carry metadata, sentences and fallback, and no raw text", () => {
  const a = caseSpanAttributes(run, c, header);
  expect(JSON.parse(a["input.value"] as string)).toEqual({ question: "Is he a fit?", history: run.history });
  expect(a["output.value"]).toBe("He led a team.");
  expect(JSON.parse(a.metadata as string)).toEqual({
    caseId: "fit-01", category: "fit", language: "en", source: "tuple", model: "stub", rep: 2, promptHash: "p123", corpusHash: "c123",
    judges: ["J0_rubric"], isPrivate: false, gitSha: "abc",
  });
  expect(JSON.parse(a["agent.sentences"] as string)).toEqual([{ text: "He led a team.", sources: ["Moonfare"] }]);
  expect(a["agent.fallback.reason"]).toBe("blocked");
  expect(a["agent.fallback.detail"]).toBe("blocklist term #3");
  expect(a["agent.cost_usd"]).toBe(0.25);
  expect(JSON.stringify(a)).not.toContain("RAWBLOCKEDSENTENCE");
  expect(Object.keys(a).some((k) => /raw/i.test(k))).toBe(false);
});

test("caseLanguage is ru for a question with a Cyrillic word, else en", () => {
  expect(caseLanguage({ question: "Где работал Эдгар?" })).toBe("ru");
  expect(caseLanguage({ question: "Where did Edgar work?" })).toBe("en");
});

test("guardrail spans carry check names and pass only", async () => {
  exporter.reset();
  await withCaseSpan(
    () => ({ "output.value": "reply" }),
    async () =>
      recordGuardrails([
        { name: "mustInclude#1", pass: true },
        { name: "mustInclude#2", pass: false, reason: "SECRETREASON" },
        { name: "lang", pass: true },
      ]),
  );
  const spans = exporter.getFinishedSpans();
  const root = spans.find((s) => s.name === "case")!;
  expect(root.attributes["openinference.span.kind"]).toBe("CHAIN");
  const guards = spans.filter((s) => s.attributes["openinference.span.kind"] === "GUARDRAIL");
  expect(guards.map((s) => [s.name, s.attributes["output.value"]])).toEqual([["mustInclude", "fail"], ["lang", "pass"]]);
  for (const g of guards) {
    expect(g.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(Object.keys(g.attributes).sort()).toEqual(["openinference.span.kind", "output.value"]);
  }
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("SECRETREASON");
});

test("a multi-turn case span carries its session id", async () => {
  exporter.reset();
  await withCaseSpan(() => ({}), async () => undefined, "mt-01:0");
  expect(exporter.getFinishedSpans()[0].attributes["session.id"]).toBe("mt-01:0");
});
