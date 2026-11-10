import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT } from "../src/prompt";
import type { CaseResult, EvalCase, Msg, Turn } from "../src/types";
import type { CaseRun, GateJudge, LoadedCase } from "./run";

/*
 * Results files. Every run writes two:
 *  - ../private/evals/results/<stamp>.json (gitignored): every run in full, with rawText (the model's
 *    raw text, including blocked sentences).
 *  - evals/results/<stamp>.json (gitignored): public runs without rawText; private runs only as
 *    id, category and pass.
 * Labels join runs on traceId, or on (caseId, model, rep) when traceId is null.
 */

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = { publicDir: join(PUBLIC_ROOT, "evals/results"), privateDir: resolve(PUBLIC_ROOT, "../private/evals/results") };

export type RunHeader = {
  model: string;
  agent: "real" | "stub";
  startedAt: string;
  repeat: number;
  only: EvalCase["category"] | null;
  ids: string[] | null;
  subset: "all" | "pr" | "golden";
  judgeSkipped: boolean;
  incomplete: boolean;
  stoppedForBudget: boolean;
  costUsd: number;
  judgeCostUsd: number;
  promptHash: string;
  corpusHash: string;
  caseSetVersion: string;
  sdkVersions: { anthropic: string; deepeval: string | null; phoenixClient: string | null; phoenixOtel: string | null; node: string };
  judges: { id: string; model: string; promptHash: string }[];
  gitSha: string;
  experimentId?: string;
};
export type StoredRun = {
  id: string;
  category: EvalCase["category"];
  source: CaseResult["source"];
  slice?: EvalCase["slice"];
  rep: number;
  model: string;
  traceId: string | null;
  question: string;
  history: Msg[];
  followUps: string[];
  reply: string;
  turns: Turn[];
  events: CaseResult["events"];
  checks: CaseResult["checks"];
  pass: boolean;
  latencyMs: CaseResult["latencyMs"];
  spend: CaseRun["spend"];
  rawText?: string;
  /** Private file only. */
  isPrivate?: boolean;
};
export type Redacted = Pick<CaseResult, "id" | "category" | "pass">;
export type ResultsFile = { header: RunHeader; runs: StoredRun[] };

export const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** What may be written under public/ or logged for a private case: no reply text, no reasons. */
export const redact = (r: CaseResult): Redacted => ({ id: r.id, category: r.category, pass: r.pass });

/** Hash of every loaded case (as its JSON line), sorted by id. */
export function caseSetVersion(cases: LoadedCase[]): string {
  const lines = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ isPrivate: _, ...c }) => JSON.stringify(c));
  return sha12(lines.join("\n"));
}

const pkgVersion = (name: string): string | null => {
  try {
    return JSON.parse(readFileSync(join(PUBLIC_ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PUBLIC_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function buildHeader(o: {
  model: string;
  agent: "real" | "stub";
  startedAt: string;
  repeat: number;
  only: EvalCase["category"] | null;
  ids: string[] | null;
  judgeSkipped: boolean;
  incomplete: boolean;
  stoppedForBudget: boolean;
  costUsd: number;
  judgeCostUsd: number;
  career: string;
  cases: LoadedCase[];
  judges: GateJudge[];
  system?: string;
}): RunHeader {
  const { career, cases, judges, system, ...rest } = o;
  return {
    ...rest,
    subset: "all",
    promptHash: sha12(system ?? SYSTEM_PROMPT),
    corpusHash: sha12(career),
    caseSetVersion: caseSetVersion(cases),
    sdkVersions: {
      anthropic: pkgVersion("@anthropic-ai/sdk") ?? "unknown",
      deepeval: pkgVersion("deepeval"),
      phoenixClient: pkgVersion("@arizeai/phoenix-client"),
      phoenixOtel: pkgVersion("@arizeai/phoenix-otel"),
      node: process.version,
    },
    judges: judges.map((j) => ({ id: j.id, model: j.model, promptHash: j.promptHash })),
    gitSha: gitSha(),
  };
}

export function toStored(run: CaseRun): StoredRun {
  const r = run.result;
  const turns = r.turns ?? [];
  return {
    id: r.id,
    category: r.category,
    source: r.source,
    slice: r.slice,
    rep: r.rep,
    model: r.model,
    traceId: r.traceId,
    question: run.question,
    history: run.history,
    followUps: turns.slice(1).map((t) => t.question),
    reply: r.reply ?? "",
    turns,
    events: r.events,
    checks: r.checks,
    pass: r.pass,
    latencyMs: r.latencyMs,
    spend: run.spend,
    rawText: run.rawText,
  };
}

export function writeResults(
  stamp: string,
  header: RunHeader,
  runs: CaseRun[],
  isPrivate: (id: string) => boolean,
  dirs = DIRS,
): { publicPath: string; privatePath: string } {
  const publicPath = join(dirs.publicDir, `${stamp}.json`);
  const privatePath = join(dirs.privateDir, `${stamp}.json`);
  const pub = runs.map((run) => {
    if (isPrivate(run.result.id)) return redact(run.result);
    const { rawText: _, ...rest } = toStored(run);
    return rest;
  });
  const priv = runs.map((run) => ({ ...toStored(run), isPrivate: isPrivate(run.result.id) }));
  mkdirSync(dirs.privateDir, { recursive: true });
  writeFileSync(privatePath, JSON.stringify({ header, runs: priv }, null, 2));
  mkdirSync(dirs.publicDir, { recursive: true });
  writeFileSync(publicPath, JSON.stringify({ header, runs: pub }, null, 2));
  return { publicPath, privatePath };
}
