import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt";
import type { AgentEvent } from "../src/types";
import { BUDGETS } from "./budgets";
import { runCase, type AgentFn, type GateJudge, type LoadedCase } from "./run";
import type { JudgeHeader } from "./results";
import { buildHeader, caseSetVersion, sha12, writeResults, type ResultsFile } from "./results";

const mk = (o: Partial<LoadedCase> & { id: string }): LoadedCase => ({ category: "facts", question: "q", isPrivate: false, ...o });
const blockedAgent: AgentFn = async function* (_c, o) {
  o?.onText?.("Fine. The secretterm is $999k.");
  yield { type: "sentence", text: "Fine.", sources: [] };
  yield { type: "fallback", reason: "blocked", detail: "blocklist#1" };
  yield { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, model: "m" } as AgentEvent;
};
const deps = { agent: blockedAgent, judges: [] as GateJudge[], rep: 0, model: "m", career: "C" };
const J0: JudgeHeader = { id: "J0_rubric", model: "claude-sonnet-5-5", promptHash: "abcdefabcdef" };
const headerFor = (cases: LoadedCase[], judges: JudgeHeader[] = []) =>
  buildHeader({
    model: "m", agent: "stub", startedAt: "2026-01-01T00:00:00.000Z", repeat: 1, only: null, ids: null, judgeSkipped: false, incomplete: false,
    stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, career: "CAREER", cases, judges,
  });
const write = async (cases: LoadedCase[]) => {
  const runs = await Promise.all(cases.map((c) => runCase(c, deps)));
  const dirs = { publicDir: mkdtempSync(join(tmpdir(), "pub-")), privateDir: mkdtempSync(join(tmpdir(), "priv-")) };
  const priv = new Set(cases.filter((c) => c.isPrivate).map((c) => c.id));
  const { publicPath, privatePath } = writeResults("stamp", headerFor(cases), runs, (id) => priv.has(id), dirs);
  return { pub: readFileSync(publicPath, "utf8"), priv: readFileSync(privatePath, "utf8") };
};

test("public results never contain rawText", async () => {
  const { pub, priv } = await write([mk({ id: "a" })]);
  expect(pub).not.toContain("secretterm");
  expect(pub).not.toContain("rawText");
  expect(priv).toContain("secretterm");
  expect((JSON.parse(pub) as ResultsFile).runs[0]).toMatchObject({ id: "a", reply: "Fine." });
});

test("private file holds every case in full; public file redacts private cases", async () => {
  const { pub, priv } = await write([mk({ id: "a" }), mk({ id: "p", isPrivate: true, question: "private question text" })]);
  const p = JSON.parse(priv) as ResultsFile;
  expect(p.runs.map((r) => r.id)).toEqual(["a", "p"]);
  expect(p.runs[1]).toMatchObject({ question: "private question text", reply: "Fine.", rawText: expect.stringContaining("secretterm") });
  const u = JSON.parse(pub) as ResultsFile;
  expect(u.runs[1]).toEqual({ id: "p", category: "facts", pass: expect.any(Boolean) });
  expect(pub).not.toContain("private question text");
});

test("stored runs carry a private flag in the private file", async () => {
  const { pub, priv } = await write([mk({ id: "a" }), mk({ id: "p", isPrivate: true })]);
  expect((JSON.parse(priv) as ResultsFile).runs.map((r) => r.isPrivate)).toEqual([false, true]);
  expect(pub).not.toContain("isPrivate");
});

test("startedAt records the given start time", () => {
  expect(headerFor([mk({ id: "a" })]).startedAt).toBe("2026-01-01T00:00:00.000Z");
});

test("header records promptHash, corpusHash, caseSetVersion, sdkVersions and agent kind", () => {
  const h = headerFor([mk({ id: "a" })]);
  expect(h.promptHash).toBe(sha12(SYSTEM_PROMPT));
  expect(h.corpusHash).toBe(sha12("CAREER"));
  expect(h.caseSetVersion).toMatch(/^[0-9a-f]{12}$/);
  expect(h.sdkVersions.anthropic).toMatch(/^\d+\.\d+\.\d+/);
  expect(h.sdkVersions.node).toBe(process.version);
  for (const k of ["deepeval", "phoenixClient", "phoenixOtel"] as const) expect(h.sdkVersions).toHaveProperty(k);
  expect(h.agent).toBe("stub");
  expect(h.subset).toBe("all");
  expect(typeof h.gitSha).toBe("string");
  expect(sha12("x")).toBe("2d711642b726"); // SHA-256 of "x"
});

test("caseSetVersion changes when any case line changes", () => {
  const a = [mk({ id: "a" }), mk({ id: "b", mustInclude: ["x"] })];
  const b = [mk({ id: "a" }), mk({ id: "b", mustInclude: ["y"] })];
  expect(caseSetVersion(a)).not.toBe(caseSetVersion(b));
  expect(caseSetVersion(a)).toBe(caseSetVersion([...a].reverse())); // sorted by id
});

test("header lists every judge used with model and prompt hash", () => {
  expect(headerFor([mk({ id: "a" })], [J0]).judges).toEqual([{ id: "J0_rubric", model: "claude-sonnet-5-5", promptHash: "abcdefabcdef" }]);
  expect(headerFor([mk({ id: "a" })]).judges).toEqual([]);
});

test("standing budgets", () => {
  expect(BUDGETS.pr).toEqual({ "claude-haiku-5-5": 0.5, "claude-sonnet-5-5": 1.5 });
  expect(BUDGETS.full).toEqual({ "claude-haiku-5-5": 3, "claude-sonnet-5-5": 6 });
});
