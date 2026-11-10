import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { loadCases, type LoadedCase } from "../run";
import { PHOENIX_URL, phoenixUp, usePhoenixEnv } from "./env";
import { caseLanguage } from "./trace";
import type { Example } from "./types";

/*
 * Phoenix datasets (phoenix-review.md 3.1): career-agent-public from public/evals/cases and
 * career-agent-private from private/evals, one example per case with the case id as its id, so
 * experiments line up across dataset versions. Split "holdout" for ids in
 * private/evals/splits/holdout.json (E9), else "dev". Uploading is declarative: createDataset
 * replaces the examples with these (a new version when they changed).
 *
 *   npm run phoenix:datasets
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_CASES = resolve(HERE, "../cases");
export const PRIVATE_CASES = resolve(HERE, "../../../private/evals");
export const HOLDOUT_PATH = resolve(HERE, "../../../private/evals/splits/holdout.json");
export const DATASETS = { public: "career-agent-public", private: "career-agent-private" } as const;

export function toExample(c: LoadedCase, holdout: Set<string>): Example & { id: string } {
  return {
    id: c.id,
    input: { question: c.question, history: c.history ?? [], followUps: c.followUps ?? [] },
    output: {
      mustInclude: c.mustInclude ?? [],
      mustNotInclude: c.mustNotInclude ?? [],
      expectHandoff: c.expectHandoff ?? null,
      sections: c.sections ?? [],
      rubric: c.judge ?? null,
    },
    metadata: { category: c.category, language: caseLanguage(c), source: c.source ?? "handwritten", tuple: c.tuple ?? null },
    splits: [holdout.has(c.id) ? "holdout" : "dev"],
  };
}

/** Holdout case ids from E9's `{ seed, ids }`; empty until E9 writes the file, so every example is dev. */
export function loadHoldout(path = HOLDOUT_PATH): Set<string> {
  return existsSync(path) ? new Set<string>(JSON.parse(readFileSync(path, "utf8")).ids) : new Set();
}

export type CreateDataset = (p: { name: string; description: string; examples: Example[] }) => Promise<{ datasetId: string }>;

export async function uploadDatasets(cases: LoadedCase[], holdout: Set<string>, deps: { createDataset: CreateDataset }): Promise<void> {
  for (const kind of ["public", "private"] as const) {
    const examples = cases.filter((c) => c.isPrivate === (kind === "private")).map((c) => toExample(c, holdout));
    if (examples.length)
      await deps.createDataset({ name: DATASETS[kind], description: `career agent ${kind} eval cases`, examples });
  }
}

async function main() {
  usePhoenixEnv();
  if (!(await phoenixUp(PHOENIX_URL))) throw new Error(`Phoenix is not reachable at ${PHOENIX_URL}; start private/phoenix/serve.sh`);
  const client = createClient({ options: { baseUrl: PHOENIX_URL } });
  const cases = loadCases([PUBLIC_CASES, ...(existsSync(PRIVATE_CASES) ? [PRIVATE_CASES] : [])]);
  await uploadDatasets(cases, loadHoldout(), { createDataset: (p) => createDataset({ client, ...p }) });
  const nPrivate = cases.filter((c) => c.isPrivate).length;
  console.log(`uploaded ${cases.length - nPrivate} public and ${nPrivate} private examples`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
