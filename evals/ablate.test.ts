import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt";
import type { CaseResult } from "../src/types";
import { ablate, ablation } from "./ablate";
import { buildHeader, sha12 } from "./results";
import { resolveAgent, runCases, type LoadedCase } from "./run";
import { gates } from "./score";

const SECTIONS = ["source", "handoffs", "commitments", "conflicts", "fit_and_gaps", "boundaries", "language", "style"];

test("ablate removes exactly the named section", () => {
  const out = ablate(SYSTEM_PROMPT, "fit_and_gaps");
  expect(out).not.toContain("<fit_and_gaps>");
  expect(out).not.toContain("</fit_and_gaps>");
  for (const s of SECTIONS.filter((s) => s !== "fit_and_gaps")) expect(out).toContain(`<${s}>`);
  expect(out).not.toMatch(/\n\n\n/);
  expect(ablate("a\n\n<x>\nb\n</x>\n\n<y>\nc\n</y>", "x")).toBe("a\n\n<y>\nc\n</y>");
});

test("ablate throws on an unknown section", () => {
  expect(() => ablate(SYSTEM_PROMPT, "nope")).toThrow("Unknown prompt section");
});

const result = (id: string, category: CaseResult["category"], pass: boolean, source: CaseResult["source"]): CaseResult => ({
  id, category, pass, checks: [], fellBack: false, handedOff: false, rep: 0, model: "m", source, traceId: null, events: [],
  latencyMs: { firstSentence: null, total: 0 },
});

test("ablation results never enter the gates", () => {
  const rs = [result("a", "facts", true, "handwritten"), result("b", "facts", false, "ablation"), result("c", "attacks", false, "ablation")];
  const g = gates(rs);
  expect(g.passed).toBe(true);
  expect(g.lines.find((l) => l.name === "facts")).toMatchObject({ k: 1, n: 1 });
  expect(g.lines.find((l) => l.name === "attacks")).toMatchObject({ k: 0, n: 0 });
  expect(Object.keys(g.byCategory)).toEqual(["facts"]);
});

test("--ablate sends the reduced system prompt and tags every run ablation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ablate-"));
  const mod = join(dir, "agent.mjs");
  writeFileSync(
    mod,
    `globalThis.ablateSeen = [];
export const makeAgent = (model, o) => async function* () {
  globalThis.ablateSeen.push(o.system);
  yield { type: "sentence", text: "x", sources: [] };
  yield { type: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, model };
};`,
  );
  const { system, source } = ablation("handoffs");
  const { agent } = await resolveAgent(mod, "m", { system });
  const cases: LoadedCase[] = [{ id: "a", category: "facts", question: "q", isPrivate: false }];
  const out = await runCases(cases, { agent, model: "m", career: "", source, repeat: 2 });
  const seen = (globalThis as unknown as { ablateSeen: string[] }).ablateSeen;
  expect(seen).toEqual([system, system]);
  expect(seen[0]).not.toContain("<handoffs>");
  expect(out.results.map((r) => r.source)).toEqual(["ablation", "ablation"]);
  const header = buildHeader({
    model: "m", agent: "stub", startedAt: "t", repeat: 2, only: null, ids: null, judgeSkipped: false, incomplete: false,
    stoppedForBudget: false, costUsd: 0, judgeCostUsd: 0, career: "", cases, judges: [], system,
  });
  expect(header.promptHash).toBe(sha12(system));
  expect(header.promptHash).not.toBe(sha12(SYSTEM_PROMPT));
});
