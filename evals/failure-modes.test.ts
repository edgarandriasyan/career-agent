import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./run";

/* The E11 failure taxonomy (failure-modes.json): one entry per failure mode, with its check or judge id. */

type FailureMode = {
  id: string;
  name: string;
  definition: string;
  pass: string;
  fail: string;
  kind: string;
  evaluator: string;
  role?: string;
  counts: Record<string, Record<string, number>>;
  exampleCaseIds: string[];
};

const modes: FailureMode[] = JSON.parse(readFileSync(resolve(__dirname, "failure-modes.json"), "utf8"));
const HOLDOUT = resolve(__dirname, "../../private/evals/splits/holdout.json");
const ROLES = ["unsupported-claim", "stretched-fit", "handoff", "commitment", "persona", "private-detail", "drift"];

test("every failure mode has definition, pass and fail boundaries, kind and evaluator", () => {
  expect(modes.length).toBeGreaterThan(0);
  for (const m of modes) {
    for (const k of ["name", "definition", "pass", "fail"] as const) expect(m[k]?.trim(), `${m.id} ${k}`).toBeTruthy();
    expect(["specification", "generalization"], `${m.id} kind`).toContain(m.kind);
    expect(["code", "judge", "none"], `${m.id} evaluator`).toContain(m.evaluator);
    for (const byCategory of Object.values(m.counts))
      for (const n of Object.values(byCategory)) expect(Number.isInteger(n) && n > 0, `${m.id} counts`).toBe(true);
  }
});

test("failure-mode example ids are public cases", () => {
  const publicIds = new Set(loadCases([resolve(__dirname, "cases")]).map((c) => c.id));
  const holdout = new Set<string>(existsSync(HOLDOUT) ? JSON.parse(readFileSync(HOLDOUT, "utf8")).ids : []);
  for (const m of modes)
    for (const id of m.exampleCaseIds) {
      expect(publicIds.has(id), `${m.id}: ${id} is not a public case`).toBe(true);
      expect(holdout.has(id), `${m.id}: ${id} is a holdout case`).toBe(false);
    }
});

test("mode ids are kebab-case and unique; each role is used at most once", () => {
  for (const m of modes) expect(m.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(new Set(modes.map((m) => m.id)).size).toBe(modes.length);
  const roles = modes.flatMap((m) => (m.role ? [m.role] : []));
  for (const r of roles) expect(ROLES).toContain(r);
  expect(new Set(roles).size).toBe(roles.length);
});
