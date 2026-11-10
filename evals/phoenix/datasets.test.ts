import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { LoadedCase } from "../run";
import { DATASETS, loadHoldout, toExample, uploadDatasets } from "./datasets";

const mk = (o: Partial<LoadedCase> & { id: string }): LoadedCase => ({ category: "facts", question: "q", isPrivate: false, ...o });

test("toExample puts holdout ids in the holdout split", () => {
  const c = mk({
    id: "fit-01", category: "fit", question: "Fit for a PM role?", history: [{ role: "user", text: "hi" }], followUps: ["And why?"],
    mustInclude: ["PM"], mustNotInclude: ["CEO"], expectHandoff: false, sections: ["Moonfare"], judge: "Says why.", source: "tuple", tuple: "t1",
  });
  expect(toExample(c, new Set(["fit-01"]))).toEqual({
    id: "fit-01",
    input: { question: "Fit for a PM role?", history: [{ role: "user", text: "hi" }], followUps: ["And why?"] },
    output: { mustInclude: ["PM"], mustNotInclude: ["CEO"], expectHandoff: false, sections: ["Moonfare"], rubric: "Says why." },
    metadata: { category: "fit", language: "en", source: "tuple", tuple: "t1" },
    splits: ["holdout"],
  });
  const dev = toExample(mk({ id: "facts-01", question: "Где?" }), new Set(["fit-01"]));
  expect(dev.splits).toEqual(["dev"]);
  expect(dev.input).toEqual({ question: "Где?", history: [], followUps: [] });
  expect(dev.output).toEqual({ mustInclude: [], mustNotInclude: [], expectHandoff: null, sections: [], rubric: null });
  expect(dev.metadata).toEqual({ category: "facts", language: "ru", source: "handwritten", tuple: null });
});

test("loadHoldout returns an empty set when holdout.json is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "holdout-"));
  expect(loadHoldout(join(dir, "holdout.json"))).toEqual(new Set());
  writeFileSync(join(dir, "holdout.json"), JSON.stringify({ seed: 1, ids: ["a", "b"] }));
  expect(loadHoldout(join(dir, "holdout.json"))).toEqual(new Set(["a", "b"]));
});

test("uploadDatasets sends public cases to career-agent-public and private cases to career-agent-private", async () => {
  const sent: { name: string; ids: (string | null | undefined)[] }[] = [];
  const createDataset = async (p: { name: string; examples: { id?: string | null }[] }) => {
    sent.push({ name: p.name, ids: p.examples.map((e) => e.id) });
    return { datasetId: p.name };
  };
  await uploadDatasets([mk({ id: "a" }), mk({ id: "p", isPrivate: true }), mk({ id: "b" })], new Set(), { createDataset });
  expect(DATASETS).toEqual({ public: "career-agent-public", private: "career-agent-private" });
  expect(sent).toEqual([
    { name: "career-agent-public", ids: ["a", "b"] },
    { name: "career-agent-private", ids: ["p"] },
  ]);
});
