import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { CaseSource, EvalCase } from "../src/types";
import { loadCases } from "./run";
import { stratifiedSplit } from "./splits";

const PUBLIC_CASES = resolve(__dirname, "cases");
const PRIVATE_CASES = resolve(__dirname, "../../private/evals");
const HOLDOUT = resolve(__dirname, "../../private/evals/splits/holdout.json");
// The private repo is absent in the public copy, so private cases and the sealed holdout are optional.
const cases = loadCases([PUBLIC_CASES, ...(existsSync(PRIVATE_CASES) ? [PRIVATE_CASES] : [])]);
const tuples: { id: string; status: "kept" | "dropped" }[] = readFileSync(resolve(__dirname, "synthetic/tuples.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const SOURCES: CaseSource[] = ["handwritten", "tuple", "deepeval-synth", "simulated", "ablation", "production"];
const SLICES: NonNullable<EvalCase["slice"]>[] = ["happy", "edge", "adversarial", "should-refuse", "should-not-trigger"];

test("every tuple-sourced case names a kept tuple", () => {
  const kept = new Set(tuples.filter((t) => t.status === "kept").map((t) => t.id));
  const fromTuples = cases.filter((c) => c.source === "tuple");
  expect(fromTuples.length).toBeGreaterThan(0);
  for (const c of fromTuples) expect(kept.has(c.tuple ?? ""), `${c.id} names tuple ${c.tuple}`).toBe(true);
});

test("multiturn cases have 1 to 3 followUps and no scripted assistant turns", () => {
  const multi = cases.filter((c) => c.category === "multiturn");
  expect(multi.length).toBeGreaterThan(0);
  for (const c of multi) {
    expect(c.followUps?.length ?? 0, c.id).toBeGreaterThanOrEqual(1);
    expect(c.followUps!.length, c.id).toBeLessThanOrEqual(3);
    expect((c.history ?? []).some((m) => m.role === "assistant"), `${c.id} scripts an assistant turn`).toBe(false);
  }
});

test("holdout is 20% of each category within one case per sealing round (E9 is round 1), with no duplicate ids", () => {
  // The sealed file is the source of truth: ids never move back to dev. New cases join the holdout in a
  // later sealing round (append their 20%, bump rounds), so each round may add one case of rounding per category.
  const sealed = existsSync(HOLDOUT)
    ? (JSON.parse(readFileSync(HOLDOUT, "utf8")) as { seed: number; rounds: number; ids: string[] })
    : undefined;
  const ids = sealed?.ids ?? stratifiedSplit(cases, (c) => c.category, [0.8, 0.2], 1)[1].map((c) => c.id);
  const rounds = sealed?.rounds ?? 1;
  const known = new Set(cases.map((c) => c.id));
  expect(known.size).toBe(cases.length);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(known.has(id), `holdout id ${id} has no case`).toBe(true);
  const held = new Set(ids);
  for (const cat of new Set(cases.map((c) => c.category))) {
    const inCat = cases.filter((c) => c.category === cat);
    expect(Math.abs(inCat.filter((c) => held.has(c.id)).length - 0.2 * inCat.length), cat).toBeLessThan(rounds);
  }
});

test("the false-refusal population has at least 40 cases", () => {
  // Same population as the false-refusal check: recruiter cases and expectHandoff:false cases.
  const population = cases.filter((c) => c.category === "recruiter" || c.expectHandoff === false);
  expect(population.length).toBeGreaterThanOrEqual(40);
});

test("every case has a slice and a known source; every slice has at least 10 cases", () => {
  for (const c of cases) {
    expect(SLICES, `${c.id} slice`).toContain(c.slice);
    expect(SOURCES, `${c.id} source`).toContain(c.source);
  }
  for (const s of SLICES) expect(cases.filter((c) => c.slice === s).length, s).toBeGreaterThanOrEqual(10);
});
