import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { AgentEvent, EvalCase } from "../src/types";
import { CATEGORIES, gateSummary, loadCases, redact, runCases, type LoadedCase } from "./run";
import { judge } from "./judge";

const say = (text: string): AgentEvent => ({ type: "sentence", text, sources: [] });
const done: AgentEvent = { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, model: "stub" };
const mk = (o: Partial<LoadedCase> & { id: string }): LoadedCase =>
  ({ category: "facts", question: "q", isPrivate: false, ...o });
const stub = (events: AgentEvent[]) =>
  async function* () {
    yield* events;
  };

test("runCases joins sentences, scores, sums cost", async () => {
  const { results, costUsd } = await runCases([mk({ id: "a", mustInclude: ["8%"] })], { agent: stub([say("Grew 8%."), say("Good."), done]) });
  expect(results[0].pass).toBe(true);
  expect(results[0].reply).toBe("Grew 8%. Good.");
  expect(costUsd).toBe(0.5);
});

test("an agent that throws becomes a fallback, not a crash", async () => {
  const { results } = await runCases([mk({ id: "a" })], {
    agent: async function* () {
      throw new Error("boom secretterm");
    },
  });
  expect(results[0].fellBack).toBe(true);
  expect(JSON.stringify(results)).not.toContain("secretterm");
});

test("--only filters and --repeat repeats", async () => {
  const cases = [mk({ id: "a" }), mk({ id: "b", category: "tone" })];
  const { results } = await runCases(cases, { agent: stub([say("ok")]), only: "tone", repeat: 3 });
  expect(results.map((r) => r.id)).toEqual(["b", "b", "b"]);
});

test("rubric cases use the injected judge, and fail when it fails", async () => {
  const c = mk({ id: "a", judge: "rubric" });
  const pass = await runCases([c], { agent: stub([say("x")]), judge: async () => ({ name: "judge", pass: true }) });
  const fail = await runCases([c], { agent: stub([say("x")]), judge: async () => ({ name: "judge", pass: false, reason: "r" }) });
  expect([pass.results[0].pass, fail.results[0].pass]).toEqual([true, false]);
});

test("without a judge, rubric cases are skipped and flagged", async () => {
  const out = await runCases([mk({ id: "a", judge: "rubric" })], { agent: stub([say("x")]) });
  expect(out.judgeSkipped).toBe(true);
  expect(out.results[0].checks.some((k) => k.name === "judge")).toBe(false);
});

test("a throwing judge fails the case", async () => {
  const { results } = await runCases([mk({ id: "a", judge: "rubric" })], {
    agent: stub([say("x")]),
    judge: async () => {
      throw new Error("net");
    },
  });
  expect(results[0].pass).toBe(false);
});

test("private judge reasons are redacted", async () => {
  const { results } = await runCases([mk({ id: "a", isPrivate: true, judge: "r" })], {
    agent: stub([say("x")]),
    judge: async () => ({ name: "judge", pass: false, reason: "mentions secretterm" }),
  });
  expect(JSON.stringify(results)).not.toContain("secretterm");
});

test("redact keeps only id, category and pass", () =>
  expect(redact({ id: "a", category: "facts", pass: true, checks: [], fellBack: false, handedOff: false, reply: "secretterm" })).toEqual({
    id: "a",
    category: "facts",
    pass: true,
  }));

test("judge sends rubric, reply and corpus only, with the pinned model and no sampling params", async () => {
  let params: any;
  const client = {
    messages: {
      create: async (p: any) => {
        params = p;
        return { content: [{ type: "text", text: 'Here: {"pass": true, "reason": "fine"}' }] };
      },
    },
  };
  const r = await judge({ id: "a", category: "fit", question: "SECRET-QUESTION", judge: "RUBRIC-TEXT" }, "REPLY-TEXT", { client, corpus: "CORPUS-TEXT" });
  expect(r).toEqual({ name: "judge", pass: true, reason: "fine" });
  expect(params.model).toBe("claude-sonnet-5-5");
  const sent = JSON.stringify(params);
  for (const s of ["RUBRIC-TEXT", "REPLY-TEXT", "CORPUS-TEXT"]) expect(sent).toContain(s);
  expect(sent).not.toContain("SECRET-QUESTION");
  for (const k of ["temperature", "top_p", "top_k", "thinking", "tools"]) expect(params).not.toHaveProperty(k);
  // Low effort and room for thinking, so the JSON is not cut off by max_tokens.
  expect(params.output_config).toEqual({ effort: "low" });
  expect(params.max_tokens).toBe(1024);
  // The corpus is a cached system block; the per-case rubric and reply come after it.
  const corpusBlock = params.system.at(-1);
  expect(corpusBlock.text).toContain("CORPUS-TEXT");
  expect(corpusBlock.cache_control).toEqual({ type: "ephemeral" });
  const user = JSON.stringify(params.messages);
  expect(user).toContain("RUBRIC-TEXT");
  expect(user).toContain("REPLY-TEXT");
  expect(user).not.toContain("CORPUS-TEXT");
});

test("judge fails closed on unparseable output", async () => {
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: "looks good" }] }) } };
  expect((await judge({ id: "a", category: "fit", question: "q", judge: "r" }, "x", { client, corpus: "c" })).pass).toBe(false);
});

test("incomplete runs never pass the gates", () => {
  const ok = { passed: true, invented: 0, leaks: 0, attackBlockRate: 1, falseRefusalRate: 0 };
  expect(gateSummary(ok, false).exitCode).toBe(0);
  const inc = gateSummary(ok, true);
  expect(inc.exitCode).toBe(1);
  expect(inc.line).toContain("INCOMPLETE");
  expect(inc.line).not.toContain("PASS");
});

// ---- the shipped case files ----
const casesDir = resolve(__dirname, "cases");
const privateDir = resolve(__dirname, "../../private/evals");
const pub = loadCases([casesDir]);
const all = existsSync(privateDir) ? loadCases([casesDir, privateDir]) : pub;
const corpus = readFileSync(resolve(__dirname, "../corpus/career.md"), "utf8");
const headings = new Set([...corpus.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim()));

test("all nine categories are covered", () => {
  for (const cat of CATEGORIES) expect(all.some((c) => c.category === cat), cat).toBe(true);
});
test("case count is 60 to 100 when the private set is present", () => {
  if (all !== pub) expect(all.length).toBeGreaterThanOrEqual(60);
  expect(all.length).toBeLessThanOrEqual(100);
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
    agent: stub([say("x"), done]),
    judge: async () => ({ name: "judge", pass: true, costUsd: 0.25 }),
    onResult: (_r, _c, spend) => seen.push(spend),
  });
  expect(seen).toEqual([{ usage: done.type === "done" ? done.usage : undefined, costUsd: 0.5, judgeCostUsd: 0.25 }]);
  expect(out.costUsd).toBe(0.5);
  expect(out.judgeCostUsd).toBe(0.25);
  expect(JSON.stringify(out.results[0].checks)).not.toContain("costUsd");
});

test("judge reports its cost from usage", async () => {
  const client = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: '{"pass": true, "reason": "ok"}' }],
        usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    },
  };
  const r = await judge({ id: "a", category: "fit", question: "q", judge: "r" }, "x", { client, corpus: "c" });
  expect(r.costUsd).toBeCloseTo(2);
});
